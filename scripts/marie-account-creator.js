/**
 * Marie — Account Creator
 *
 * Reads marie-signup-config.json, processes all entries with status: "pending":
 *   1. Navigates to signup URL with Playwright
 *   2. Fills in form intelligently (email + alias, name, password)
 *   3. Submits and waits for verification email via Gmail API
 *   4. Clicks verification link
 *   5. Saves login + credentials to Airtable
 *   6. Updates config entry status to "done" or "failed"
 *
 * Triggered manually: workflow_dispatch with TASK=signup
 *
 * Secrets required:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_USER_EMAIL
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING
 *   SIGNUP_PASSWORD  — base password to use for all new accounts
 */

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ─── Config ───────────────────────────────────────────────────────────────────

const AIRTABLE_API_KEY   = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID   = 'app6biS7yjV6XzFVG';
const AIRTABLE_LOGINS    = 'tbldJkG11gY1W3jTf';
const AIRTABLE_CREDS     = 'tblvBr6RIc7bcGXYJ';

const GMAIL_CLIENT_ID    = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_USER_EMAIL   = process.env.GMAIL_USER_EMAIL;

const SLACK_BOT_TOKEN    = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL      = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN            = process.env.DRY_RUN === 'true';

const SIGNUP_PASSWORD    = process.env.SIGNUP_PASSWORD;

const CONFIG_FILE = path.join(__dirname, 'marie-signup-config.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function buildEmail(base, alias) {
  return `${base}+${alias}@gmail.com`;
}

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

// ─── Gmail — wait for verification email ─────────────────────────────────────

async function getGmailClient() {
  const auth = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

async function waitForVerificationEmail(gmail, fromDomain, toAlias, timeoutMs = 90000) {
  console.log(`  Waiting for verification email from *${fromDomain}* to +${toAlias}...`);
  const start = Date.now();
  const query = `to:${toAlias} newer_than:5m`;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 8000));

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 5,
    });

    const messages = res.data.messages || [];
    for (const msg of messages) {
      const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers;
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';

      // Check it's from the right domain
      if (!from.toLowerCase().includes(fromDomain.toLowerCase())) continue;

      console.log(`  Found email: "${subject}" from ${from}`);

      // Extract body text
      const body = extractEmailBody(full.data.payload);

      // Find verification/confirmation link
      const linkMatch = body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|validate)[^\s"'<>]*/i)
        || body.match(/https?:\/\/[^\s"'<>]{20,}/);

      if (linkMatch) {
        console.log(`  Verification link found: ${linkMatch[0].slice(0, 80)}...`);
        return linkMatch[0];
      }
    }
  }

  console.warn(`  No verification email found after ${timeoutMs / 1000}s`);
  return null;
}

function extractEmailBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractEmailBody(part);
      if (text) return text;
    }
  }
  return '';
}

// ─── Airtable — save credentials ─────────────────────────────────────────────

async function saveToAirtable(site, email, password) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save to Airtable: ${site.name} / ${email}`);
    return;
  }

  try {
    // Create Login record
    const loginRes = await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LOGINS}`,
      {
        fields: {
          fldQqf8eF4mT2U0zT: site.name,            // Name
          fldoqWChj7NAo6uRg: email,                  // Login (email)
          fldqoPo0O06uAHILu: password,               // Password
          fldcZ9nAY8GD2OZW8: 'Active',               // Status
          fldmNEniveVp5upxh: 'Email / Password',     // Login Type
          fldupBswggA36MOyI: site.notes || '',       // Product Details
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const loginId = loginRes.data.id;
    console.log(`  ✅ Login saved to Airtable: ${loginId}`);

    // Create Credential record linked to the login
    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CREDS}`,
      {
        fields: {
          fld2lJoFqSGAEK5tw: `${site.name} — ${email}`,   // Name
          flddhlUwVQW6vrY55: [loginId],                     // Login (linked)
          fldSNad5zoyLbpebm: 'Password',                    // Credential Type
          fld4tDedZ5uGVy3gP: 'Active',                      // Status
          fldXq9LKkrwecF5Fp: email,                         // Account / Owner
          fldGMbEDOCtLXqbLX: password,                      // Value
          fld5NI6ls6Qu16wnL: site.notes || '',              // Notes
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`  ✅ Credentials saved to Airtable`);

  } catch (err) {
    console.warn('  Airtable save failed:', err.response?.data?.error || err.message);
  }
}

// ─── Playwright — sign up ────────────────────────────────────────────────────

async function signUp(page, site, defaults, email, password) {
  console.log(`\n  Navigating to: ${site.url}`);
  await page.goto(site.url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  // Smart form filler — looks for common field patterns
  const filled = await page.evaluate((data) => {
    const { email, password, firstName, lastName, company } = data;
    let filledCount = 0;

    function fill(selectors, value) {
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.offsetParent !== null && !el.disabled && !el.readOnly) { // visible + enabled
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

    // Password (fill both password + confirm password)
    const pwFields = document.querySelectorAll('input[type="password"]');
    pwFields.forEach(el => {
      el.value = password;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      filledCount++;
    });

    // First name
    fill(['input[name*="first" i]', 'input[id*="first" i]', 'input[placeholder*="first" i]', 'input[autocomplete="given-name"]'], firstName);

    // Last name
    fill(['input[name*="last" i]', 'input[id*="last" i]', 'input[placeholder*="last" i]', 'input[autocomplete="family-name"]'], lastName);

    // Full name (if separate first/last not found)
    fill(['input[name*="name" i]:not([name*="user" i]):not([name*="company" i])', 'input[id*="fullname" i]', 'input[placeholder*="full name" i]'], `${firstName} ${lastName}`);

    // Company (optional)
    fill(['input[name*="company" i]', 'input[id*="company" i]', 'input[name*="org" i]'], company);

    return filledCount;
  }, { email, password, firstName: defaults.firstName, lastName: defaults.lastName, company: defaults.company });

  console.log(`  Filled ${filled} field(s)`);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-filled.png` });

  if (filled === 0) {
    console.warn('  No fields filled — signup form may need manual selector tuning');
    return { success: false, reason: 'No fields found to fill' };
  }

  // Find and click submit button
  const submitted = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[type="submit"], input[type="submit"], button')];
    const submitBtn = btns.find(b => {
      const text = (b.innerText || b.value || '').toLowerCase();
      return /sign up|register|create|get started|join|continue/i.test(text);
    });
    if (submitBtn) { submitBtn.click(); return true; }
    return false;
  });

  if (!submitted) {
    console.warn('  Could not find submit button');
    return { success: false, reason: 'Submit button not found' };
  }

  console.log('  Form submitted');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-after.png` });

  // Check for success indicators
  const pageText = await page.evaluate(() => document.body.innerText);
  const success = /verify|check your email|confirmation|welcome|account created|success|thank you/i.test(pageText);
  const error = /error|invalid|already exists|already registered|try again/i.test(pageText);

  if (error) {
    const errorMatch = pageText.match(/(error|invalid|already)[^\n]{0,100}/i);
    return { success: false, reason: errorMatch?.[0] || 'Error detected on page' };
  }

  return { success: true, needsVerification: success };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Marie — Account Creator');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!SIGNUP_PASSWORD) {
    throw new Error('SIGNUP_PASSWORD secret not set');
  }
  if (!AIRTABLE_API_KEY) {
    throw new Error('AIRTABLE_API_KEY not set');
  }

  const config = loadConfig();
  const { defaults, signups } = config;
  const pending = signups.filter(s => s.status === 'pending');

  console.log(`\nPending signups: ${pending.length}`);
  if (pending.length === 0) {
    console.log('Nothing to do. Add entries with status: "pending" to marie-signup-config.json');
    return;
  }

  const gmail = await getGmailClient();
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-AU',
  });

  const results = { done: [], failed: [] };

  for (const site of pending) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Site: ${site.name}`);
    console.log(`URL: ${site.url}`);

    const email = buildEmail(defaults.emailBase, site.emailAlias);
    console.log(`Email: ${email}`);

    const page = await context.newPage();

    try {
      // Step 1: Sign up
      const signupResult = await signUp(page, site, defaults, email, SIGNUP_PASSWORD);

      if (!signupResult.success) {
        console.log(`  ❌ Signup failed: ${signupResult.reason}`);
        results.failed.push({ name: site.name, reason: signupResult.reason });
        site.status = 'failed';
        site.failReason = signupResult.reason;
        await page.close();
        continue;
      }

      console.log(`  ✅ Signup submitted`);

      // Step 2: Handle email verification if needed
      if (signupResult.needsVerification) {
        const domain = new URL(site.url).hostname.replace('www.', '');
        const verifyLink = await waitForVerificationEmail(gmail, domain, email);

        if (verifyLink) {
          const verifyPage = await context.newPage();
          try {
            console.log(`  Clicking verification link...`);
            await verifyPage.goto(verifyLink, { waitUntil: 'networkidle', timeout: 30000 });
            await verifyPage.waitForTimeout(2000);
            await verifyPage.screenshot({ path: `/tmp/marie-signup-${site.id}-verified.png` });
            console.log(`  ✅ Verification completed`);
          } catch (err) {
            console.warn(`  Verification link navigation failed: ${err.message}`);
          }
          await verifyPage.close();
        } else {
          console.warn(`  ⚠️ Could not find verification email — account may still be pending`);
        }
      }

      // Step 3: Save to Airtable
      await saveToAirtable(site, email, SIGNUP_PASSWORD);

      results.done.push({ name: site.name, email });
      site.status = 'done';
      site.completedAt = new Date().toISOString();
      site.emailUsed = email;

    } catch (err) {
      console.error(`  ❌ Error processing ${site.name}:`, err.message);
      results.failed.push({ name: site.name, reason: err.message });
      site.status = 'failed';
      site.failReason = err.message;
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000)); // brief pause between sites
  }

  await browser.close();

  // Save updated config (with status changes)
  if (!DRY_RUN) saveConfig(config);

  // Post summary to Slack
  const lines = [`🔐 *Kondo — Account Creator Summary*`];
  if (results.done.length) {
    lines.push(`\n✅ *Created (${results.done.length}):*`);
    results.done.forEach(r => lines.push(`• ${r.name} (${r.email})`));
  }
  if (results.failed.length) {
    lines.push(`\n❌ *Failed (${results.failed.length}):*`);
    results.failed.forEach(r => lines.push(`• ${r.name} — ${r.reason}`));
  }
  lines.push(`\n_Credentials saved to Airtable Logins + Credentials tables._`);
  await postToSlack(lines.join('\n'));

  console.log('\n✅ Account creator done.');
  console.log(`   Created: ${results.done.length} | Failed: ${results.failed.length}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
