/**
 * Marie — Account Creator
 *
 * Reads the Airtable "Signup Queue" table for entries with Status = "Pending":
 *   1. Generates a fresh temp email via Temp Mail API (Privatix / RapidAPI)
 *   2. Navigates to signup URL with Playwright
 *   3. Fills form intelligently (email, name, password, username)
 *   4. Submits and polls Temp Mail inbox for verification email
 *   5. Clicks verification link
 *   6. Saves login + credentials to Airtable Logins + Credentials tables
 *   7. Updates Signup Queue record status to "Done" or "Failed"
 *   8. Posts summary to Slack
 *
 * Triggered manually: workflow_dispatch with TASK=signup
 *
 * Secrets required:
 *   RAPIDAPI_KEY
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING
 *   SIGNUP_PASSWORD  — base password for all new accounts
 */

const { chromium } = require('playwright');
const axios = require('axios');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────

const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID  = 'app6biS7yjV6XzFVG';
const AIRTABLE_QUEUE    = 'tbl0mLelR78YJjKwV';   // Signup Queue
const AIRTABLE_LOGINS   = 'tbldJkG11gY1W3jTf';   // Logins
const AIRTABLE_CREDS    = 'tblvBr6RIc7bcGXYJ';   // Credentials

const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY;
const TEMPMAIL_HOST     = 'privatix-temp-mail-v1.p.rapidapi.com';

const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL     = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const SIGNUP_PASSWORD   = process.env.SIGNUP_PASSWORD;
const DRY_RUN           = process.env.DRY_RUN === 'true';

// Default name details for signup forms
const DEFAULTS = {
  firstName: 'Ben',
  lastName: 'Collier',
  company: 'Rascals Inc',
};

// ─── Temp Mail API ────────────────────────────────────────────────────────────

async function getTempMailDomains() {
  const res = await axios.get('https://privatix-temp-mail-v1.p.rapidapi.com/request/domains/', {
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': TEMPMAIL_HOST,
    },
  });
  return res.data; // array of domain strings e.g. ["@mailto.plus", ...]
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

async function generateTempEmail(siteName) {
  const domains = await getTempMailDomains();
  // Pick first available domain
  const domain = domains[0];
  // Username: lowercase site name + random suffix
  const slug = siteName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  const suffix = Math.random().toString(36).slice(2, 7);
  const email = `${slug}${suffix}${domain}`;
  console.log(`  Generated temp email: ${email}`);
  return email;
}

async function waitForVerificationEmail(email, timeoutMs = 120000) {
  const hash = md5(email);
  console.log(`  Polling Temp Mail inbox for ${email} (md5: ${hash})...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 8000));

    try {
      const res = await axios.get(
        `https://privatix-temp-mail-v1.p.rapidapi.com/request/mail/id/${hash}/`,
        {
          headers: {
            'x-rapidapi-key': RAPIDAPI_KEY,
            'x-rapidapi-host': TEMPMAIL_HOST,
          },
        }
      );

      const messages = Array.isArray(res.data) ? res.data : [];
      if (messages.length === 0) {
        console.log(`  No messages yet...`);
        continue;
      }

      // Find a message that looks like a verification email
      for (const msg of messages) {
        const subject = msg.mail_subject || '';
        const body = msg.mail_text_only || msg.mail_html || '';
        console.log(`  Found message: "${subject}"`);

        // Extract verification link
        const linkMatch = body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|validate)[^\s"'<>]*/i)
          || body.match(/https?:\/\/[^\s"'<>]{30,}/);

        if (linkMatch) {
          console.log(`  Verification link: ${linkMatch[0].slice(0, 80)}...`);
          return linkMatch[0];
        }
      }
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`  Inbox empty (404), waiting...`);
      } else {
        console.warn(`  Temp Mail poll error: ${err.message}`);
      }
    }
  }

  console.warn(`  No verification email found after ${timeoutMs / 1000}s`);
  return null;
}

// ─── Airtable — Signup Queue ──────────────────────────────────────────────────

async function getPendingSignups() {
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_QUEUE}`,
    {
      params: {
        filterByFormula: `{Status} = "Pending"`,
        fields: ['Name', 'URL', 'Email Alias', 'Category', 'Status', 'Notes'],
      },
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    }
  );
  return res.data.records;
}

async function updateSignupStatus(recordId, status, fields = {}) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${recordId} → ${status}`);
    return;
  }
  await axios.patch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_QUEUE}/${recordId}`,
    {
      fields: {
        Status: status,
        ...fields,
      },
    },
    { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
  );
}

async function saveToAirtable(siteName, email, password, notes) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save to Airtable: ${siteName} / ${email}`);
    return null;
  }

  try {
    // Create Login record
    const loginRes = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LOGINS}`,
      {
        fields: {
          fldQqf8eF4mT2U0zT: siteName,
          fldoqWChj7NAo6uRg: email,
          fldqoPo0O06uAHILu: password,
          fldcZ9nAY8GD2OZW8: 'Active',
          fldmNEniveVp5upxh: 'Email / Password',
          fldupBswggA36MOyI: notes || '',
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const loginId = loginRes.data.id;
    console.log(`  ✅ Login saved: ${loginId}`);

    // Create Credential record
    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CREDS}`,
      {
        fields: {
          fld2lJoFqSGAEK5tw: `${siteName} — ${email}`,
          flddhlUwVQW6vrY55: [loginId],
          fldSNad5zoyLbpebm: 'Password',
          fld4tDedZ5uGVy3gP: 'Active',
          fldXq9LKkrwecF5Fp: email,
          fldGMbEDOCtLXqbLX: password,
          fld5NI6ls6Qu16wnL: notes || '',
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`  ✅ Credentials saved`);
    return loginId;

  } catch (err) {
    console.warn(`  Airtable save failed:`, err.response?.data?.error || err.message);
    return null;
  }
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(text) {
  if (DRY_RUN) { console.log('[DRY RUN] Slack:', text); return; }
  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: SLACK_CHANNEL, text },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) { console.warn('Slack failed:', err.message); }
}

// ─── Playwright — sign up ─────────────────────────────────────────────────────

async function signUp(page, site, email, password) {
  const url = site.fields['URL'];
  const siteName = site.fields['Name'];

  console.log(`\n  Navigating to: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  const filled = await page.evaluate((data) => {
    const { email, password, firstName, lastName, company, username } = data;
    let filledCount = 0;

    function fill(selectors, value) {
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.offsetParent !== null && !el.disabled && !el.readOnly) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            filledCount++;
            return true;
          }
        }
      }
      return false;
    }

    // Email
    fill(['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]'], email);

    // Password fields (password + confirm)
    const pwFields = document.querySelectorAll('input[type="password"]');
    pwFields.forEach(el => {
      el.value = password;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filledCount++;
    });

    // Username
    fill([
      'input[name*="username" i]', 'input[id*="username" i]',
      'input[placeholder*="username" i]', 'input[autocomplete="username"]',
      'input[name="user"]', 'input[id="user"]',
    ], username);

    // First name
    fill(['input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="first" i]', 'input[autocomplete="given-name"]'], firstName);

    // Last name
    fill(['input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="last" i]', 'input[autocomplete="family-name"]'], lastName);

    // Full name
    fill(['input[name*="fullname" i]', 'input[id*="fullname" i]', 'input[placeholder*="full name" i]'], `${firstName} ${lastName}`);

    // Name (generic — only if no first/last filled)
    fill(['input[name="name"]:not([name*="user" i]):not([name*="company" i])'], `${firstName} ${lastName}`);

    // Company
    fill(['input[name*="company" i]', 'input[id*="company" i]', 'input[name*="org" i]'], company);

    return filledCount;
  }, {
    email,
    password,
    firstName: DEFAULTS.firstName,
    lastName: DEFAULTS.lastName,
    company: DEFAULTS.company,
    username: email.split('@')[0], // use email local part as username
  });

  console.log(`  Filled ${filled} field(s)`);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-filled.png` });

  if (filled === 0) {
    return { success: false, reason: 'No fields found to fill' };
  }

  // Find and click submit button
  const submitted = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[type="submit"], input[type="submit"], button')];
    const submitBtn = btns.find(b => {
      const text = (b.innerText || b.value || '').toLowerCase();
      return /sign up|register|create|get started|join|continue|next/i.test(text);
    });
    if (submitBtn) { submitBtn.click(); return true; }
    return false;
  });

  if (!submitted) {
    return { success: false, reason: 'Submit button not found' };
  }

  console.log('  Form submitted');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-after.png` });

  const pageText = await page.evaluate(() => document.body.innerText);
  const hasError = /error|invalid|already exists|already registered|try again/i.test(pageText);

  if (hasError) {
    const errorMatch = pageText.match(/(error|invalid|already)[^\n]{0,100}/i);
    return { success: false, reason: errorMatch?.[0] || 'Error detected on page' };
  }

  const needsVerification = /verify|check your email|confirmation|welcome|account created|success|thank you/i.test(pageText);
  return { success: true, needsVerification };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Marie — Account Creator');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!SIGNUP_PASSWORD) throw new Error('SIGNUP_PASSWORD not set');
  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');

  const pending = await getPendingSignups();
  console.log(`\nPending signups: ${pending.length}`);

  if (pending.length === 0) {
    console.log('Nothing to do. Add entries with Status = "Pending" to the Signup Queue Airtable table.');
    return;
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-AU',
  });

  const results = { done: [], failed: [] };

  for (const site of pending) {
    const siteName = site.fields['Name'];
    const siteUrl  = site.fields['URL'];
    const notes    = site.fields['Notes'] || '';

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Site: ${siteName}`);
    console.log(`URL:  ${siteUrl}`);

    const page = await context.newPage();

    try {
      // Step 1: Generate temp email
      const email = await generateTempEmail(siteName);

      // Step 2: Sign up
      const signupResult = await signUp(page, site, email, SIGNUP_PASSWORD);

      if (!signupResult.success) {
        console.log(`  ❌ Signup failed: ${signupResult.reason}`);
        results.failed.push({ name: siteName, reason: signupResult.reason });
        await updateSignupStatus(site.id, 'Failed', { 'Fail Reason': signupResult.reason });
        await page.close();
        continue;
      }

      console.log(`  ✅ Signup submitted`);

      // Step 3: Verify email if needed
      if (signupResult.needsVerification) {
        const verifyLink = await waitForVerificationEmail(email);

        if (verifyLink) {
          const verifyPage = await context.newPage();
          try {
            console.log(`  Clicking verification link...`);
            await verifyPage.goto(verifyLink, { waitUntil: 'networkidle', timeout: 30000 });
            await verifyPage.waitForTimeout(2000);
            await verifyPage.screenshot({ path: `/tmp/marie-signup-${site.id}-verified.png` });
            console.log(`  ✅ Email verified`);
          } catch (err) {
            console.warn(`  Verification navigation failed: ${err.message}`);
          }
          await verifyPage.close();
        } else {
          console.warn(`  ⚠️ No verification email found — account may still be pending`);
        }
      }

      // Step 4: Save to Airtable
      await saveToAirtable(siteName, email, SIGNUP_PASSWORD, notes);

      // Step 5: Update Signup Queue
      await updateSignupStatus(site.id, 'Done', {
        'Email Used': email,
        'Completed At': new Date().toISOString(),
      });

      results.done.push({ name: siteName, email });

    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      results.failed.push({ name: siteName, reason: err.message });
      await updateSignupStatus(site.id, 'Failed', { 'Fail Reason': err.message });
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  // Slack summary
  const lines = [`🔐 *Kondo — Account Creator Summary*`];
  if (results.done.length) {
    lines.push(`\n✅ *Created (${results.done.length}):*`);
    results.done.forEach(r => lines.push(`• ${r.name} → ${r.email}`));
  }
  if (results.failed.length) {
    lines.push(`\n❌ *Failed (${results.failed.length}):*`);
    results.failed.forEach(r => lines.push(`• ${r.name} — ${r.reason}`));
  }
  lines.push(`\n_Credentials saved to Airtable Logins + Credentials._`);
  await postToSlack(lines.join('\n'));

  console.log(`\n✅ Done. Created: ${results.done.length} | Failed: ${results.failed.length}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
