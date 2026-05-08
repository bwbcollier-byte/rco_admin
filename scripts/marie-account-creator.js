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
const MAX_PER_RUN       = parseInt(process.env.MAX_PER_RUN || '20', 10);

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

async function pollInbox(email, timeoutMs = 120000) {
  const hash = md5(email);
  console.log(`  Polling Temp Mail inbox for ${email}...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await axios.get(
        `https://privatix-temp-mail-v1.p.rapidapi.com/request/mail/id/${hash}/`,
        { headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': TEMPMAIL_HOST } }
      );
      const messages = Array.isArray(res.data) ? res.data : [];
      if (messages.length > 0) return messages;
      console.log(`  No messages yet...`);
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`  Inbox empty (404), waiting...`);
      } else {
        console.warn(`  Temp Mail poll error: ${err.message}`);
      }
    }
  }
  return [];
}

async function waitForOMDBKey(email, timeoutMs = 120000) {
  const messages = await pollInbox(email, timeoutMs);
  for (const msg of messages) {
    const body = msg.mail_text_only || msg.mail_html || '';
    console.log(`  Found message: "${msg.mail_subject}"`);
    // OMDB keys are 8 alphanumeric chars
    const keyMatch = body.match(/\b([a-f0-9]{8})\b/i);
    if (keyMatch) {
      console.log(`  OMDB API key found: ${keyMatch[1]}`);
      return keyMatch[1];
    }
  }
  console.warn(`  No OMDB API key found in inbox`);
  return null;
}

async function saveOMDBApiKey(email, apiKey) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save OMDB API key to Credentials: ${apiKey}`);
    return;
  }
  try {
    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CREDS}`,
      {
        fields: {
          fld2lJoFqSGAEK5tw: `OMDB — ${email}`,
          fldSNad5zoyLbpebm: 'API Key',
          fld4tDedZ5uGVy3gP: 'Active',
          fldXq9LKkrwecF5Fp: email,
          fldGMbEDOCtLXqbLX: apiKey,
          fldivTYDSK44aY26J: 'Use as ?apikey= query param on omdbapi.com',
          fld5NI6ls6Qu16wnL: 'Free tier — 1,000 daily requests',
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`  ✅ OMDB API key saved to Credentials`);
  } catch (err) {
    console.warn(`  Airtable save failed:`, err.response?.data?.error || err.message);
  }
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

// ─── Playwright — generic field filler ───────────────────────────────────────

async function fillStandardForm(page, email, password) {
  return page.evaluate((data) => {
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

    fill(['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[placeholder*="email" i]'], email);

    const pwFields = document.querySelectorAll('input[type="password"]');
    pwFields.forEach(el => {
      if (el.offsetParent !== null && !el.disabled && !el.readOnly) {
        el.value = password;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        filledCount++;
      }
    });

    fill(['input[name*="username" i]', 'input[id*="username" i]', 'input[placeholder*="username" i]', 'input[autocomplete="username"]', 'input[name="user"]', 'input[id="user"]'], username);
    fill(['input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="first" i]', 'input[autocomplete="given-name"]'], firstName);
    fill(['input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="last" i]', 'input[autocomplete="family-name"]'], lastName);
    fill(['input[name*="fullname" i]', 'input[id*="fullname" i]', 'input[placeholder*="full name" i]'], `${firstName} ${lastName}`);
    fill(['input[name="name"]:not([name*="user" i]):not([name*="company" i])'], `${firstName} ${lastName}`);
    fill(['input[name*="company" i]', 'input[id*="company" i]', 'input[name*="org" i]'], company);

    // Tick any terms/agreement checkboxes
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (!cb.checked && cb.offsetParent !== null) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
        cb.dispatchEvent(new Event('click', { bubbles: true }));
        filledCount++;
      }
    });

    return filledCount;
  }, {
    email,
    password,
    firstName: DEFAULTS.firstName,
    lastName: DEFAULTS.lastName,
    company: DEFAULTS.company,
    username: email.split('@')[0],
  });
}

function clickSubmit(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[type="submit"], input[type="submit"], button')];
    const btn = btns.find(b => /sign up|register|create|get started|join|continue|next|submit/i.test(b.innerText || b.value || ''));
    if (btn) { btn.click(); return true; }
    return false;
  });
}

// Real Playwright click — more reliable than JS .click() for React/Auth0 SPAs
async function playwrightClickSubmit(page) {
  try {
    const btn = page.locator('button[type="submit"], input[type="submit"]').first();
    await btn.click({ timeout: 5000 });
    return true;
  } catch {
    // Fallback: find by text
    const texts = ['Continue', 'Sign up', 'Register', 'Create account', 'Submit', 'Get started'];
    for (const text of texts) {
      try {
        await page.getByRole('button', { name: new RegExp(text, 'i') }).first().click({ timeout: 3000 });
        return true;
      } catch { /* try next */ }
    }
    return false;
  }
}

async function checkPageResult(page, siteId, label) {
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/marie-signup-${siteId}-${label}.png` });
  const text = await page.evaluate(() => document.body.innerText);
  const hasError = /error|invalid|already exists|already registered|try again/i.test(text);
  if (hasError) {
    const m = text.match(/(error|invalid|already)[^\n]{0,100}/i);
    return { success: false, reason: m?.[0] || 'Error detected on page' };
  }
  const needsVerification = /verify|check your email|confirmation|welcome|account created|success|thank you/i.test(text);
  return { success: true, needsVerification };
}

// ─── Site-specific flows ──────────────────────────────────────────────────────

// Multi-step Auth0-style signup: email → Continue → password → submit
// Used by Tavily and Cerebras
async function signUpMultiStep(page, site, email, password) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  // Step 1: fill email using Playwright's real fill()
  try {
    const emailSel = 'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]';
    await page.waitForSelector(emailSel, { timeout: 8000 });
    await page.fill(emailSel, email);
  } catch {
    return { success: false, reason: `${site.fields['Name']}: email field not found` };
  }

  // Click Continue with real Playwright click
  const step1 = await playwrightClickSubmit(page);
  if (!step1) return { success: false, reason: `${site.fields['Name']}: Continue button not found on step 1` };

  // Step 2: wait for password field
  try {
    await page.waitForSelector('input[type="password"]', { timeout: 12000 });
  } catch {
    return { success: false, reason: `${site.fields['Name']}: password field never appeared after Continue` };
  }
  await page.waitForTimeout(1000);

  // Fill password + confirm if present
  const pwFields = await page.$$('input[type="password"]');
  for (const field of pwFields) {
    await field.fill(password);
  }

  const step2 = await playwrightClickSubmit(page);
  if (!step2) return { success: false, reason: `${site.fields['Name']}: submit button not found on step 2` };

  console.log('  Form submitted (multi-step)');
  return checkPageResult(page, site.id, 'after');
}

const signUpTavily   = signUpMultiStep;
const signUpCerebras = signUpMultiStep;

// OMDB — email-based API key request form (no account, just email + name)
async function signUpOMDB(page, site, email) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  // Select free tier radio
  try { await page.check('input[type="radio"][value*="free" i], input[type="radio"][value="1"]'); } catch {}

  // Fill fields with real Playwright fill()
  const tryFill = async (selectors, value) => {
    for (const sel of selectors) {
      try { await page.fill(sel, value); return; } catch {}
    }
  };
  await tryFill(['input[name="emailaddress"]', 'input[type="email"]'], email);
  await tryFill(['input[name="firstname"]', 'input[id*="first" i]'], DEFAULTS.firstName);
  await tryFill(['input[name="lastname"]', 'input[id*="last" i]'], DEFAULTS.lastName);

  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-filled.png` });

  const submitted = await playwrightClickSubmit(page);
  if (!submitted) return { success: false, reason: 'OMDB: submit button not found' };

  console.log('  Key request submitted');
  return checkPageResult(page, site.id, 'after');
}

// ─── Playwright — sign up dispatcher ─────────────────────────────────────────

async function signUp(page, site, email, password) {
  const url = site.fields['URL'];
  const siteName = site.fields['Name'];

  console.log(`\n  Navigating to: ${url}`);

  // Site-specific flows
  if (siteName === 'Tavily')   return signUpTavily(page, site, email, password);
  if (siteName === 'Cerebras') return signUpCerebras(page, site, email, password);
  if (siteName === 'OMDB')     return signUpOMDB(page, site, email);

  // Generic flow
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  const filled = await fillStandardForm(page, email, password);
  console.log(`  Filled ${filled} field(s)`);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-filled.png` });

  if (filled === 0) return { success: false, reason: 'No fields found to fill' };

  const submitted = await clickSubmit(page);
  if (!submitted) return { success: false, reason: 'Submit button not found' };

  console.log('  Form submitted');
  return checkPageResult(page, site.id, 'after');
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

  const allPending = await getPendingSignups();
  const pending = allPending.slice(0, MAX_PER_RUN);
  console.log(`\nPending signups: ${allPending.length} total, processing ${pending.length} (max ${MAX_PER_RUN})`);

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

      if (siteName === 'OMDB') {
        // OMDB: extract API key from email, save as Credential only (no Login/password)
        const apiKey = await waitForOMDBKey(email);
        if (apiKey) {
          await saveOMDBApiKey(email, apiKey);
        } else {
          console.warn(`  ⚠️ OMDB key not received — check ${email} manually`);
        }
      } else {
        // Step 3: Verify email if needed
        if (signupResult.needsVerification) {
          const verifyLink = await waitForVerificationEmail(email);

          if (verifyLink) {
            const verifyPage = await context.newPage();
            try {
              console.log(`  Clicking verification link...`);
              await verifyPage.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

        // Step 4: Save Login + Credential to Airtable
        await saveToAirtable(siteName, email, SIGNUP_PASSWORD, notes);
      }

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
