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
const AIRTABLE_APIS     = 'tblMb9HFyKcnQ7aKb';   // APIs

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

// ─── Gmail API ────────────────────────────────────────────────────────────────


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
        fields: ['Name', 'URL', 'Category', 'Status', 'Notes'],
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
          fldmNEniveVp5upxh: 'Email Password',
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
          fldSNad5zoyLbpebm: 'Other',
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

// ─── Airtable — RapidAPI subscription list ────────────────────────────────────

async function getUnsubscribedRapidAPIs() {
  // Returns APIs table records where Source = "RapidAPI" and Subscribed = false
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}`,
    {
      params: {
        filterByFormula: `AND({Source} = "RapidAPI", NOT({Subscribed}))`,
        fields: ['Name', 'Link'],
      },
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    }
  );
  return res.data.records || [];
}

async function markRapidAPISubscribed(recordId) {
  if (DRY_RUN) { console.log(`  [DRY RUN] Would mark API ${recordId} as subscribed`); return; }
  await axios.patch(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}/${recordId}`,
    { fields: { fldFBb9KjAeY1XCsn: true } },
    { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
  );
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
    const texts = ['Continue', 'Continue with email', 'Sign up', 'Register', 'Create account', 'Submit', 'Get started'];
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

// Multi-step signup: handles WorkOS (Cerebras) and Auth0 (Tavily) flows
async function signUpMultiStep(page, site, email, password) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });
  console.log(`  Landed URL: ${page.url()}`);

  // Step -1: Dismiss cookie consent banner if present (e.g. CookieYes on WorkOS pages)
  const cookieDismiss = [
    '#cookieyes-accept', 'button.cky-btn-accept',
    'button[id*="accept"]', 'button[class*="accept"]',
    'button:has-text("Accept All")', 'button:has-text("Accept all")',
    'button:has-text("Accept")', 'button:has-text("I Accept")',
    'button:has-text("Allow All")', 'button:has-text("Allow all")',
    'button:has-text("Got it")', 'button:has-text("Agree")',
    'button:has-text("OK")',
  ];
  let cookieDismissed = false;
  for (const sel of cookieDismiss) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
      await page.click(sel);
      console.log(`  Dismissed cookie consent: ${sel}`);
      await page.waitForTimeout(2000);
      cookieDismissed = true;
      break;
    } catch {}
  }
  // Fallback: remove CookieYes banner elements via JS
  if (!cookieDismissed) {
    const removed = await page.evaluate(() => {
      const selectors = [
        '.cky-consent-container', '.cky-overlay', '#cookieyes-root',
        '[class*="cookieyes"]', '[id*="cookieyes"]', '[class*="cookie-consent"]',
      ];
      let found = false;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.remove(); found = true; }
      }
      return found;
    });
    if (removed) {
      console.log('  Removed cookie banner via JS');
      await page.waitForTimeout(1000);
    }
  }

  // Step 0: Some pages (WorkOS/Cerebras) show auth method options first.
  // Click "Continue with email" / "Sign up with email" before the form appears.
  const emailTriggers = [
    'button:has-text("Continue with email")',
    'button:has-text("Sign up with email")',
    'button:has-text("Login with email")',
    'button:has-text("Sign in with email")',
    'button:has-text("Use email")',
    'a:has-text("Continue with email")',
    'a:has-text("Sign up with email")',
    'a:has-text("Login with email")',
    '[data-provider="email"]',
    '[data-method="email"]',
  ];
  for (const sel of emailTriggers) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
      await page.click(sel);
      console.log(`  Clicked email auth trigger: ${sel}`);
      await page.waitForTimeout(3000);
      break;
    } catch { /* not present */ }
  }

  // Debug: log all inputs after any trigger click
  try {
    const allInputs = await page.$$eval('input', els => els.map(el => ({
      type: el.type, id: el.id, name: el.name,
      placeholder: el.placeholder, autocomplete: el.autocomplete,
    })));
    console.log(`  Inputs after trigger: ${JSON.stringify(allInputs)}`);
  } catch {}

  // Step 1: fill email field
  const emailSelectors = [
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[placeholder*="@" i]',
    'input[type="text"]',
  ];

  let emailFilled = false;
  for (const sel of emailSelectors) {
    try {
      await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
      await page.fill(sel, email);
      emailFilled = true;
      console.log(`  Email filled via: ${sel}`);
      break;
    } catch { /* try next */ }
  }

  if (!emailFilled) {
    await page.screenshot({ path: `/tmp/marie-signup-${site.id}-email-not-found.png` });
    return { success: false, reason: `${site.fields['Name']}: email field not found` };
  }

  // Check if password field is already visible (Auth0 combined login/signup form)
  // If so, fill it directly rather than clicking Continue and waiting for it
  const pwAlreadyVisible = await page.locator('input[type="password"]').first().isVisible().catch(() => false);

  if (pwAlreadyVisible) {
    console.log('  Password field already visible — filling directly (Auth0 combined form)');
    const pwFields = await page.$$('input[type="password"]');
    for (const field of pwFields) await field.fill(password);
    const submitted = await playwrightClickSubmit(page);
    if (!submitted) return { success: false, reason: `${site.fields['Name']}: submit button not found` };
    console.log('  Form submitted (combined email+password)');
    return checkPageResult(page, site.id, 'after');
  }

  // Step 1b: click Continue to advance to password step
  async function clickContinue(ctx) {
    const texts = ['Continue', 'Continue with email', 'Sign up', 'Register', 'Create account', 'Submit', 'Get started', 'Next'];
    try {
      await ctx.locator('button[type="submit"], input[type="submit"]').first().click({ timeout: 5000 });
      return true;
    } catch {}
    for (const text of texts) {
      try {
        await ctx.getByRole('button', { name: new RegExp(text, 'i') }).first().click({ timeout: 3000 });
        return true;
      } catch {}
    }
    return false;
  }

  const step1 = await clickContinue(page);
  if (!step1) return { success: false, reason: `${site.fields['Name']}: Continue button not found on step 1` };

  // Step 2: wait for password field to appear (may require page transition)
  try {
    await page.waitForSelector('input[type="password"]', { state: 'visible', timeout: 15000 });
  } catch {
    await page.screenshot({ path: `/tmp/marie-signup-${site.id}-no-password.png` });
    console.log(`  URL after Continue: ${page.url()}`);
    try {
      const inputs = await page.$$eval('input', els => els.map(el => ({ type: el.type, id: el.id, name: el.name })));
      console.log(`  Inputs after Continue: ${JSON.stringify(inputs)}`);
    } catch {}
    return { success: false, reason: `${site.fields['Name']}: password field never appeared after Continue` };
  }
  await page.waitForTimeout(1000);

  // Fill password + confirm if present
  const pwFields = await page.$$('input[type="password"]');
  for (const field of pwFields) await field.fill(password);

  const step2 = await clickContinue(page);
  if (!step2) return { success: false, reason: `${site.fields['Name']}: submit button not found on step 2` };

  console.log('  Form submitted (multi-step)');
  return checkPageResult(page, site.id, 'after');
}


// Tavily — Auth0 identifier-first with Cloudflare Turnstile
// Password field exists in DOM but is CSS-hidden; force-fill to bypass CAPTCHA gate
async function signUpTavily(page, site, email, password) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });
  console.log(`  Landed URL: ${page.url()}`);

  // Fill email (id=username, autocomplete=email)
  try {
    await page.waitForSelector('#username, input[autocomplete="email"]', { state: 'visible', timeout: 10000 });
    await page.fill('#username, input[autocomplete="email"]', email);
    console.log('  Email filled');
  } catch {
    return { success: false, reason: 'Tavily: email field not found' };
  }

  // Force-fill hidden password field via JS (bypasses CSS visibility check)
  const pwSet = await page.evaluate((pwd) => {
    const el = document.querySelector('input[type="password"]');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, pwd);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, password);
  console.log(`  Password force-filled: ${pwSet}`);

  // Submit
  const submitted = await playwrightClickSubmit(page);
  if (!submitted) return { success: false, reason: 'Tavily: submit button not found' };
  console.log('  Form submitted');
  return checkPageResult(page, site.id, 'after');
}

// Grok/xAI — magic link flow (no password; sends login link to email)
async function signUpXAI(page, site, email, password) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log(`  Landed URL: ${page.url()}`);

  // Click "Login with email" to show email form
  try {
    await page.waitForSelector('button:has-text("Login with email")', { state: 'visible', timeout: 5000 });
    await page.click('button:has-text("Login with email")');
    await page.waitForTimeout(3000);
    console.log('  Clicked Login with email');
  } catch {}

  // Fill email
  try {
    await page.waitForSelector('input[type="email"], input[name="email"]', { state: 'visible', timeout: 8000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    console.log('  Email filled');
  } catch {
    return { success: false, reason: 'Grok / xAI: email field not found' };
  }

  // Click Continue — xAI will send a magic link email
  try {
    await page.locator('button[type="submit"]').first().click({ timeout: 5000 });
  } catch {
    try { await page.getByRole('button', { name: /continue|next|sign in|login/i }).first().click({ timeout: 3000 }); } catch {}
  }
  console.log('  Magic link requested — waiting for Gmail...');
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-submitted.png` });

  // Magic link IS the verification — return needsVerification so main loop handles it
  return { success: true, needsVerification: true };
}

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

// ─── RapidAPI — batch API subscriber ─────────────────────────────────────────
// Runs after RapidAPI account is created+verified. Browser context is already
// logged in. Iterates unsubscribed RapidAPI APIs from Airtable and clicks
// "Subscribe to Test" on the free/basic plan for each.

async function subscribeToRapidAPIs(context) {
  const apis = await getUnsubscribedRapidAPIs();
  if (apis.length === 0) {
    console.log('  No unsubscribed RapidAPI APIs found — nothing to do');
    return { subscribed: [], failed: [] };
  }
  console.log(`  Subscribing to ${apis.length} RapidAPI API(s)...`);

  const subscribed = [];
  const failed = [];

  for (const api of apis) {
    const name = api.fields['Name'] || api.id;
    const link = api.fields['Link'];
    if (!link) { failed.push({ name, reason: 'No Link field' }); continue; }

    // Normalise to the pricing tab (most reliable entry point)
    const pricingUrl = link.includes('/pricing') ? link : link.replace(/\/$/, '') + '/pricing';
    console.log(`\n  → ${name} (${pricingUrl})`);

    const page = await context.newPage();
    try {
      await page.goto(pricingUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(3000);

      // Find the free/basic plan subscribe button
      // RapidAPI renders plan cards; the free plan usually has "Subscribe" or "Select Plan"
      const subscribeSelectors = [
        'button:has-text("Subscribe to Test")',
        'button:has-text("Subscribe")',
        'button:has-text("Select Plan")',
        'a:has-text("Subscribe")',
        '[data-testid="subscribe-button"]',
      ];

      let clicked = false;
      for (const sel of subscribeSelectors) {
        try {
          // Click the FIRST visible one (free/basic tier)
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 3000 })) {
            await btn.click();
            await page.waitForTimeout(2000);
            console.log(`    Clicked: ${sel}`);
            clicked = true;
            break;
          }
        } catch {}
      }

      if (!clicked) {
        // May already be subscribed — check for "Current Plan" / "You're subscribed"
        const alreadySub = await page.locator('text=/current plan|already subscribed|you.re subscribed/i').first().isVisible().catch(() => false);
        if (alreadySub) {
          console.log(`    Already subscribed to ${name}`);
          await markRapidAPISubscribed(api.id);
          subscribed.push(name);
        } else {
          await page.screenshot({ path: `/tmp/rapidapi-${api.id}-no-btn.png` });
          failed.push({ name, reason: 'Subscribe button not found' });
        }
        await page.close();
        continue;
      }

      // Handle any confirmation modal ("Confirm subscription")
      try {
        await page.waitForSelector('button:has-text("Confirm"), button:has-text("Yes")', { state: 'visible', timeout: 4000 });
        await page.locator('button:has-text("Confirm"), button:has-text("Yes")').first().click();
        await page.waitForTimeout(2000);
        console.log(`    Confirmed subscription modal`);
      } catch {}

      // Verify success — look for success toast / "Subscribed" label
      await page.waitForTimeout(2000);
      const success = await page.locator('text=/subscribed|success/i').first().isVisible().catch(() => false);
      if (success || clicked) {
        console.log(`    ✅ Subscribed to ${name}`);
        await markRapidAPISubscribed(api.id);
        subscribed.push(name);
      } else {
        await page.screenshot({ path: `/tmp/rapidapi-${api.id}-unsure.png` });
        failed.push({ name, reason: 'Could not confirm subscription' });
      }
    } catch (err) {
      console.warn(`    ❌ ${name}: ${err.message}`);
      failed.push({ name, reason: err.message });
    }
    await page.close();
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n  RapidAPI subscriptions: ${subscribed.length} done, ${failed.length} failed`);
  return { subscribed, failed };
}

// ─── Playwright — sign up dispatcher ─────────────────────────────────────────

async function signUp(page, site, email, password) {
  const url = site.fields['URL'];
  const siteName = site.fields['Name'];

  console.log(`\n  Navigating to: ${url}`);

  // Site-specific flows
  if (siteName === 'Tavily')      return signUpTavily(page, site, email, password);
  if (siteName === 'Grok / xAI') return signUpXAI(page, site, email, password);
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
//
// Architecture:
//   ONE temp email is generated at the start of each run.
//   Phase 1 — Submit ALL signups with that email (fire-and-forget, no per-site waiting)
//   Phase 2 — Single batch inbox poll: click every verification link found
//   Phase 3 — RapidAPI: subscribe to APIs while browser is logged in
//   Phase 4 — Save credentials + mark Done for everything
//
// Next run generates a fresh email and repeats.

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

  // Generate ONE temp email for the entire batch
  const batchEmail = await generateTempEmail('rascals');
  console.log(`\nBatch email for this run: ${batchEmail}`);

  const browser = await chromium.launch({
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-AU',
    extraHTTPHeaders: { 'Accept-Language': 'en-AU,en;q=0.9' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });

  const results = { done: [], failed: [] };
  // Track successfully submitted sites for batch verification
  const submitted = []; // { site, needsVerification, isOMDB, isRapidAPI }

  // ── Phase 1: Submit all signups ──────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Phase 1 — Submitting all signups');
  console.log('═'.repeat(60));

  for (const site of pending) {
    const siteName = site.fields['Name'];
    const siteUrl  = site.fields['URL'];

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Site: ${siteName}  |  ${siteUrl}`);

    const page = await context.newPage();
    try {
      const result = await signUp(page, site, batchEmail, SIGNUP_PASSWORD);

      if (!result.success) {
        console.log(`  ❌ Signup failed: ${result.reason}`);
        results.failed.push({ name: siteName, reason: result.reason });
        await updateSignupStatus(site.id, 'Failed', { 'Fail Reason': result.reason });
      } else {
        console.log(`  ✅ Submitted`);
        submitted.push({
          site,
          needsVerification: !!result.needsVerification,
          isOMDB: siteName === 'OMDB',
          isRapidAPI: siteName === 'RapidAPI',
        });
      }
    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      results.failed.push({ name: siteName, reason: err.message });
      await updateSignupStatus(site.id, 'Failed', { 'Fail Reason': err.message });
    }

    await page.close();
    await new Promise(r => setTimeout(r, 2000));
  }

  if (submitted.length === 0) {
    console.log('\nNo sites submitted successfully — skipping verification.');
    await browser.close();
    await postSlackSummary(results, batchEmail);
    return;
  }

  // ── Phase 2: Batch inbox poll — click ALL verification links ─────────────
  const needVerify = submitted.filter(s => s.needsVerification || s.isOMDB);
  if (needVerify.length > 0) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Phase 2 — Batch verifying ${needVerify.length} account(s) from shared inbox`);
    console.log('═'.repeat(60));

    // Poll with generous timeout — all services share the same inbox
    const messages = await pollInbox(batchEmail, 180000); // 3 min
    console.log(`  Found ${messages.length} message(s) in inbox`);

    const omdbItem = submitted.find(s => s.isOMDB);

    for (const msg of messages) {
      const subject  = msg.mail_subject || '(no subject)';
      const from     = msg.mail_from    || '';
      const body     = msg.mail_text_only || msg.mail_html || '';
      console.log(`\n  Message: "${subject}" from ${from}`);

      // OMDB sends API key (not a link) — extract it
      if (omdbItem && (from.includes('omdb') || subject.toLowerCase().includes('omdb'))) {
        const keyMatch = body.match(/\b([a-f0-9]{8})\b/i);
        if (keyMatch) {
          console.log(`  OMDB API key: ${keyMatch[1]}`);
          await saveOMDBApiKey(batchEmail, keyMatch[1]);
          omdbItem.omdbDone = true;
        }
        continue;
      }

      // All others: find and click verification link
      const linkMatch =
        body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|validate|magic|token)[^\s"'<>]*/i) ||
        body.match(/https?:\/\/[^\s"'<>]{50,}/);

      if (linkMatch) {
        const link = linkMatch[0].replace(/&amp;/g, '&');
        console.log(`  Clicking: ${link.slice(0, 100)}...`);
        const verifyPage = await context.newPage();
        try {
          await verifyPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await verifyPage.waitForTimeout(3000);
          await verifyPage.screenshot({ path: `/tmp/marie-verify-${Date.now()}.png` });
          console.log(`  ✅ Verified (${verifyPage.url().slice(0, 60)}...)`);
        } catch (err) {
          console.warn(`  Verification nav failed: ${err.message}`);
        }
        await verifyPage.close();
      } else {
        console.log(`  No verification link found in this message`);
      }
    }

    if (messages.length === 0) {
      console.warn('  ⚠️ Inbox empty — verification emails may still be in transit');
    }
  }

  // ── Phase 3: RapidAPI — batch subscribe while browser is logged in ────────
  const rapidItem = submitted.find(s => s.isRapidAPI);
  if (rapidItem) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('Phase 3 — RapidAPI batch subscriptions');
    console.log('═'.repeat(60));

    // Navigate back to RapidAPI — session cookies should still be active
    const rapidPage = await context.newPage();
    try {
      await rapidPage.goto('https://rapidapi.com/hub', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await rapidPage.waitForTimeout(2000);
      const isLoggedIn = await rapidPage.locator('[data-testid="user-menu"], .user-avatar, [aria-label*="account" i]').first().isVisible().catch(() => false);
      console.log(`  RapidAPI session active: ${isLoggedIn}`);
    } catch {}
    await rapidPage.close();

    const subResults = await subscribeToRapidAPIs(context);
    rapidItem.subResults = subResults;
  }

  // ── Phase 4: Save credentials + mark Done ────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Phase 4 — Saving credentials');
  console.log('═'.repeat(60));

  for (const item of submitted) {
    const siteName = item.site.fields['Name'];
    const notes    = item.site.fields['Notes'] || '';

    try {
      if (!item.isOMDB) {
        // OMDB credentials saved separately (API key, not password)
        await saveToAirtable(siteName, batchEmail, SIGNUP_PASSWORD, notes);
      }

      await updateSignupStatus(item.site.id, 'Done', {
        'Email Used': batchEmail,
        'Completed At': new Date().toISOString(),
      });

      results.done.push({ name: siteName, email: batchEmail });
      console.log(`  ✅ ${siteName}`);
    } catch (err) {
      console.warn(`  ⚠️ Save failed for ${siteName}: ${err.message}`);
      results.failed.push({ name: siteName, reason: `Save failed: ${err.message}` });
    }
  }

  await browser.close();
  await postSlackSummary(results, batchEmail);
  console.log(`\n✅ Done. Created: ${results.done.length} | Failed: ${results.failed.length}`);
}

async function postSlackSummary(results, batchEmail) {
  const lines = [`🔐 *Kondo — Account Creator Summary*`, `_Batch email: ${batchEmail}_`];
  if (results.done.length) {
    lines.push(`\n✅ *Created (${results.done.length}):*`);
    results.done.forEach(r => lines.push(`• ${r.name}`));
  }
  if (results.failed.length) {
    lines.push(`\n❌ *Failed (${results.failed.length}):*`);
    results.failed.forEach(r => lines.push(`• ${r.name} — ${r.reason}`));
  }
  lines.push(`\n_Credentials saved to Airtable Logins + Credentials._`);
  await postToSlack(lines.join('\n'));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
