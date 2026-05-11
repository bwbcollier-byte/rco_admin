/**
 * Marie — RapidAPI Account Creator & Subscriber
 *
 * 1. Gets a fresh real Gmail address from Gmailnator (each call → a DIFFERENT base address,
 *    not a +alias — RapidAPI strips +tags so aliases can't be used for uniqueness)
 * 2. Signs up for a new RapidAPI account (uses pressSequentially — React form safe)
 * 3. Polls the Gmailnator inbox for the verification email and clicks the magic link
 * 4. Subscribes to every API in the Airtable APIs table where {Subscribe via Kondo} is checked
 * 5. Saves Login + Credential records to Airtable as Active
 * 6. Links the new Login record to every API it subscribed to
 * 7. Posts a summary to Slack
 *
 * Run on a schedule (e.g. every Monday) to continuously grow the account pool.
 * The subscriber script (marie-rapidapi-subscriber.js) handles catch-up runs and
 * picks up any new APIs added to the list between account creation runs.
 *
 * Required env vars:
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 *   AIRTABLE_LOGINS          (table ID)
 *   AIRTABLE_CREDS           (table ID)
 *   AIRTABLE_APIS            (table ID)
 *   FIELD_LOGIN_SITE_NAME    (field ID)
 *   FIELD_LOGIN_EMAIL        (field ID)
 *   FIELD_LOGIN_PASSWORD     (field ID)
 *   FIELD_LOGIN_STATUS       (field ID)
 *   FIELD_API_SUBSCRIBED     (field ID)
 *   SIGNUP_PASSWORD
 *   RAPIDAPI_KEYS            (comma-separated, used for Gmailnator with rotation)
 *   SLACK_BOT_TOKEN          (optional)
 *   SLACK_CHANNEL_AI_ENGINEERING (optional)
 */

// Auto-load .env when running locally. No-op on GitHub Actions (no .env present).
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_LOGINS  = process.env.AIRTABLE_LOGINS;
const AIRTABLE_CREDS   = process.env.AIRTABLE_CREDS;
const AIRTABLE_APIS    = process.env.AIRTABLE_APIS;

const SIGNUP_PASSWORD  = process.env.SIGNUP_PASSWORD;
const DRY_RUN          = process.env.DRY_RUN === 'true';

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL    = process.env.SLACK_CHANNEL_AI_ENGINEERING;

// Logins table field IDs
const LOGIN_FIELD = {
  siteName: process.env.FIELD_LOGIN_SITE_NAME,
  email:    process.env.FIELD_LOGIN_EMAIL,
  password: process.env.FIELD_LOGIN_PASSWORD,
  status:   process.env.FIELD_LOGIN_STATUS,
};

// APIs table field IDs
const API_FIELD = {
  subscribed:         process.env.FIELD_API_SUBSCRIBED,
  subscribedAccounts: 'Subscribed Accounts',  // linked record field — use name
};

const DEFAULTS = { firstName: 'Ben', lastName: 'Collier', company: 'Rascals Inc' };

// ─── Gmailnator (real distinct Gmail addresses, not +aliases) ────────────────
// RapidAPI strips +tags before deduping — confirmed by repeated "Username and
// email must be unique" rejections on attempts that varied only by +tag. So
// we need *distinct base addresses* per signup, which Gmailnator provides:
// each call to /api/emails/generate returns a real Gmail account from their
// pool. The 10 RAPIDAPI_KEYS are rotated for rate-limit headroom.
//
// Endpoints:
//   POST /api/emails/generate        → { email: "abc1234@gmail.com" }
//   POST /api/inbox  { email }       → { messages: [ { id, from, subject, body, ... } ] }
//   GET  /api/inbox/:messageId       → { content: "<full HTML>" }

const GMAILNATOR_HOST = 'gmailnator.p.rapidapi.com';

const _rapidKeys = (process.env.RAPIDAPI_KEYS || process.env.RAPIDAPI_KEY || '')
  .split(',').map(k => k.trim()).filter(Boolean);

function shuffledKeys() {
  return [..._rapidKeys].sort(() => Math.random() - 0.5);
}

async function createTempEmail() {
  if (process.env.SIGNUP_EMAIL) {
    console.log(`  Using provided email: ${process.env.SIGNUP_EMAIL}`);
    return { email: process.env.SIGNUP_EMAIL };
  }
  if (!_rapidKeys.length) throw new Error('RAPIDAPI_KEYS not set — needed for Gmailnator');

  // Cap total attempts so a bad-keys day doesn't burn the whole pool.
  // ~60-70% of Gmailnator responses are non-private types we skip, so we need
  // headroom to find a usable address. 30 lets us survive a high-skip streak.
  const MAX_ATTEMPTS = 30;
  let attempts = 0;
  const keys = shuffledKeys();
  while (attempts < MAX_ATTEMPTS) {
    for (const key of keys) {
      if (attempts >= MAX_ATTEMPTS) break;
      attempts++;
      try {
        const res = await axios.post(
          `https://${GMAILNATOR_HOST}/api/emails/generate`,
          {},
          {
            headers: {
              'Content-Type':    'application/json',
              'X-RapidAPI-Key':  key,
              'X-RapidAPI-Host': GMAILNATOR_HOST,
            },
            timeout: 8000,
          }
        );
        const email = res.data?.email;
        const type  = res.data?.type;
        // Only accept Gmailnator `private_*` types. Confirmed type distribution
        // from probing the API: roughly 60% public_gmail_plus (+aliases,
        // RapidAPI strips +tags so they all collapse), 10-20% public_email_domain
        // (disposable domains RapidAPI blocks with "Something went wrong"),
        // and 10-20% private_googlemail OR private_email_domain. The private_*
        // pool is many DISTINCT base accounts owned by Gmailnator — each one
        // a fresh signup for RapidAPI. private_email_domain (e.g. *@premiumnator.com)
        // is ideal, but private_googlemail works too (each call hands out a
        // different googlemail base account, so dot-stripping is irrelevant
        // until that single base has been used).
        if (!email || email.includes('+')) continue;
        if (!type || !type.startsWith('private_')) {
          console.log(`  Skipping ${email} (type=${type || 'unknown'}) — non-private domain`);
          continue;
        }
        console.log(`  Gmailnator address: ${email} (${type})`);
        return { email };
      } catch (err) {
        // 403/429 → just rotate to next key
      }
    }
  }
  throw new Error(`Gmailnator failed after ${MAX_ATTEMPTS} attempts across ${_rapidKeys.length} keys`);
}

async function fetchInboxMessages(email) {
  for (const key of shuffledKeys()) {
    try {
      const res = await axios.post(
        `https://${GMAILNATOR_HOST}/api/inbox`,
        { email },
        {
          headers: {
            'Content-Type':    'application/json',
            'X-RapidAPI-Key':  key,
            'X-RapidAPI-Host': GMAILNATOR_HOST,
          },
          timeout: 8000,
        }
      );
      return res.data?.messages || [];
    } catch (err) {
      // try next key
    }
  }
  throw new Error('All Gmailnator keys failed on /api/inbox');
}

async function fetchInboxMessageBody(messageId) {
  for (const key of shuffledKeys()) {
    try {
      const res = await axios.get(
        `https://${GMAILNATOR_HOST}/api/inbox/${encodeURIComponent(messageId)}`,
        {
          headers: {
            'Accept':          'application/json',
            'X-RapidAPI-Key':  key,
            'X-RapidAPI-Host': GMAILNATOR_HOST,
          },
          timeout: 8000,
        }
      );
      return res.data?.content || res.data?.body || '';
    } catch (err) {
      // try next key
    }
  }
  return '';
}

function extractMagicLink(text) {
  if (!text) return null;
  const cleaned = text.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');
  // RapidAPI verification emails go through a SendGrid-style click tracker on
  // a `urlNNNN.rapidapi.com/ls/click` subdomain. The bare `rapidapi.com/...`
  // is just static assets (logos) and the unsubscribe link. We want the FIRST
  // `/ls/click` URL — it follows the "Verify Email" CTA. Fall back to bare
  // rapidapi.com verify/confirm paths if the email format changes.
  const patterns = [
    /https?:\/\/url\d+\.rapidapi\.com\/ls\/click\?[^\s"'<>\n\r]+/gi,
    /https?:\/\/[a-z0-9.-]*rapidapi\.com\/[^\s"'<>\n\r]*(?:confirm|verify|magic|activate)[^\s"'<>\n\r]*/gi,
    /https?:\/\/rapidapi\.com\/auth\/[^\s"'<>\n\r]+/gi,
  ];
  for (const re of patterns) {
    const match = cleaned.match(re);
    if (match) return match[0];
  }
  return null;
}

async function pollGmailnatorForMagicLink(email, timeoutMs = 360000) {
  const POLL_INTERVAL = 10000;
  const start = Date.now();
  console.log(`  Polling Gmailnator inbox for ${email}...`);
  // Initial 10s wait so the verification email has a chance to land
  await new Promise(r => setTimeout(r, 10000));

  while (Date.now() - start < timeoutMs) {
    try {
      const messages = await fetchInboxMessages(email);
      for (const msg of messages) {
        const inlineBody = msg.body || msg.content || msg.text || '';
        let link = extractMagicLink(inlineBody);
        if (!link) {
          const id = msg.id || msg.message_id;
          if (id) {
            const fullBody = await fetchInboxMessageBody(id);
            link = extractMagicLink(fullBody);
          }
        }
        if (link) {
          console.log(`  Magic link found (subject: "${msg.subject || '?'}")`);
          return link;
        }
        if (msg.subject) console.log(`  Email in inbox but no RapidAPI link (subject: "${msg.subject}")`);
      }
      if (!messages.length) {
        console.log(`  Inbox empty — waiting... (${Math.round((Date.now() - start) / 1000)}s)`);
      }
    } catch (err) {
      console.warn(`  Gmailnator poll error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return null;
}

// ─── Airtable ─────────────────────────────────────────────────────────────────

async function getAPIsToSubscribe() {
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}`,
    {
      params: { filterByFormula: `{Subscribe via Kondo}`, fields: ['Name', 'Link'] },
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    }
  );
  return res.data.records || [];
}

async function saveLogin(email, password) {
  if (DRY_RUN) { console.log(`  [DRY RUN] Would save login: ${email}`); return null; }
  const res = await axios.post(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LOGINS}`,
    {
      fields: {
        [LOGIN_FIELD.siteName]: 'RapidAPI',
        [LOGIN_FIELD.email]:    email,
        [LOGIN_FIELD.password]: password,
        [LOGIN_FIELD.status]:   'Active',
        fldmNEniveVp5upxh:      'Email Password',
        fldupBswggA36MOyI:      `Created by Marie on ${new Date().toISOString().split('T')[0]}`,
      },
    },
    { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  const loginId = res.data.id;
  console.log(`  ✅ Login saved: ${loginId}`);
  return loginId;
}

async function saveCredential(email, password, loginId) {
  if (DRY_RUN) { console.log(`  [DRY RUN] Would save credential for ${email}`); return; }
  await axios.post(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CREDS}`,
    {
      fields: {
        fld2lJoFqSGAEK5tw: `RapidAPI — ${email}`,
        flddhlUwVQW6vrY55: loginId ? [loginId] : [],
        fldSNad5zoyLbpebm: 'Other',
        fld4tDedZ5uGVy3gP: 'Active',
        fldXq9LKkrwecF5Fp: email,
        fldGMbEDOCtLXqbLX: password,
        fld5NI6ls6Qu16wnL: `Created by Marie on ${new Date().toISOString().split('T')[0]}`,
      },
    },
    { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
  );
  console.log(`  ✅ Credential saved`);
}

async function markAPISubscribed(recordId, loginId) {
  if (DRY_RUN) { console.log(`  [DRY RUN] Would mark API ${recordId} subscribed`); return; }

  const url     = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}/${recordId}`;
  const headers = { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

  // Step 1: mark Subscribed checkbox
  await axios.patch(url, { fields: { [API_FIELD.subscribed]: true } }, { headers });

  // Step 2: append login to Subscribed Accounts (never replace)
  if (loginId) {
    try {
      const current = await axios.get(url, { headers });
      const existing = current.data.fields?.[API_FIELD.subscribedAccounts] || [];
      if (!existing.includes(loginId)) {
        await axios.patch(
          url,
          { fields: { [API_FIELD.subscribedAccounts]: [...existing, loginId] } },
          { headers }
        );
      }
    } catch (e) {
      console.warn(`  ⚠️ Could not link login to API ${recordId}: ${e.response?.status || e.message}`);
    }
  }
}

// ─── RapidAPI Signup ──────────────────────────────────────────────────────────

async function clickNext(page, stepLabel) {
  // RapidAPI uses "Next" as the primary CTA on every signup step.
  // Avoid 'form button' — it matches social login buttons (Google/GitHub).
  // Use force:true — overlays / loading spinners can intercept normal clicks.
  const sels = [
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'button:has-text("Sign Up")',
    'button:has-text("Create Account")',
    'button:has-text("Get Started")',
    'button[type="submit"]',
  ];

  for (const sel of sels) {
    try {
      const btn = page.locator(sel).first();
      if (!await btn.isVisible({ timeout: 2000 }).catch(() => false)) continue;

      const disabled = await btn.evaluate(el =>
        el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('disabled')
      ).catch(() => false);

      const txt = (await btn.textContent().catch(() => sel)).trim();
      if (disabled) console.log(`  [${stepLabel}] "${txt}" is disabled — force-clicking anyway`);
      else console.log(`  [${stepLabel}] Clicking: "${txt}"`);

      await btn.click({ force: true });   // force bypasses interception AND disabled checks
      await page.waitForTimeout(800);
      console.log(`  [${stepLabel}] Clicked ✓`);
      return true;
    } catch (e) {
      console.log(`  [${stepLabel}] Click error on "${sel}": ${e.message.split('\n')[0]}`);
    }
  }

  // Nothing worked — dump visible buttons for diagnosis
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(t => t)
  ).catch(() => []);
  console.warn(`  [${stepLabel}] No clickable button found. Visible: ${btns.slice(0, 10).join(' | ')}`);
  return false;
}

// signUp returns the actual password used (may have '!' appended to meet requirements)
async function signUp(page, email, password) {
  console.log(`\n  Navigating to RapidAPI signup...`);
  await page.goto('https://rapidapi.com/auth/sign-up', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Dismiss cookie banner
  try {
    await page.locator('button:has-text("Reject All"), button:has-text("Accept All")').first()
      .waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('button:has-text("Reject All")').first().click();
    console.log('  Dismissed cookie banner');
    await page.waitForTimeout(1500);
  } catch { console.log('  No cookie banner'); }

  // RapidAPI signup form fields (all on one page — not multi-step):
  //   Username *, Email *, Password *, Confirm Password *, Terms checkbox, Next button
  //
  // Password requirements: 8+ chars, upper+lower, digit, special char (@;!$.)

  // Gmailnator returns real distinct base addresses (no +aliases), so we pass
  // them straight through to RapidAPI. (Previously we tried Gmail +aliasing,
  // but confirmed via repeated rejections that RapidAPI strips +tags before
  // dedup, so aliases of one base address all collide.)
  const signupEmail = email;

  // Ensure password has a special character
  const signupPass = /[@;!$._#%^&*()\-]/.test(password) ? password : password + '!';
  if (signupPass !== password) console.log(`  Appended '!' to meet special-char requirement`);

  // Generate a fully random username — not derived from email so it's always unique
  const adjectives = ['swift','bright','calm','bold','keen','fair','pure','wise','neat','quick'];
  const nouns      = ['fox','dev','api','hub','byte','node','cloud','mesh','flux','core'];
  const adj  = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const username = adj + noun + Math.floor(Math.random() * 90000 + 10000);
  console.log(`  Username: ${username}`);

  await page.screenshot({ path: '/tmp/rapidapi-signup-before.png' }).catch(() => {});

  // ── Username ──
  const userInput = page.locator('input[name="username"], input[placeholder*="username" i]').first();
  if (await userInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await userInput.click();
    await userInput.pressSequentially(username, { delay: 50 });
    await userInput.press('Tab');
    await page.waitForTimeout(400);
  } else {
    console.warn('  ⚠️ Username field not found');
  }

  // ── Email ──
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  if (!await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    throw new Error('Email field not found on signup page');
  }
  await emailInput.click();
  await emailInput.pressSequentially(signupEmail, { delay: 60 });
  await emailInput.press('Tab');
  await page.waitForTimeout(500);

  // ── Password ──
  const passInput = page.locator('input[type="password"]').first();
  await passInput.click();
  await passInput.pressSequentially(signupPass, { delay: 60 });
  await passInput.press('Tab');
  await page.waitForTimeout(500);

  // ── Confirm Password ──
  const confirmInput = page.locator('input[type="password"]').nth(1);
  if (await confirmInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    await confirmInput.click();
    await confirmInput.pressSequentially(signupPass, { delay: 60 });
    await confirmInput.press('Tab');
    await page.waitForTimeout(500);
    console.log('  Confirm password filled ✓');
  }

  // ── Terms checkbox ──
  // RapidAPI uses a custom styled checkbox — clicking the label is more reliable
  // than check() on the hidden <input>, which React doesn't register.
  let checked = false;
  // Try clicking the label that wraps or follows the checkbox
  for (const sel of [
    'label:has(input[type="checkbox"])',
    'label:has-text("Terms")',
    'label:has-text("agree")',
    'label:has-text("Privacy")',
    '[class*="checkbox" i] label',
    '[class*="checkbox" i]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 }).catch(() => false)) {
        await el.click();
        checked = true;
        console.log(`  Terms checkbox clicked via: ${sel}`);
        break;
      }
    } catch {}
  }
  // Fallback: force-check the raw input + dispatch change event via JS
  if (!checked) {
    await page.evaluate(() => {
      const cb = document.querySelector('input[type="checkbox"]');
      if (cb) {
        cb.checked = true;
        cb.dispatchEvent(new MouseEvent('click',  { bubbles: true }));
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    console.log('  Terms checkbox clicked via JS evaluate fallback');
  }
  await page.waitForTimeout(800);

  await page.screenshot({ path: '/tmp/rapidapi-signup-filled.png' }).catch(() => {});

  // ── Submit ──
  const submitOk = await clickNext(page, 'submit');
  if (!submitOk) {
    console.log('  clickNext failed — trying Enter key...');
    await passInput.press('Enter');
  }

  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/rapidapi-signup-after.png' }).catch(() => {});

  // Check for "Verify your email" page — form submitted, magic link sent.
  // URL stays on /auth/sign-up so we check page content instead.
  const isVerifyPage = await page.getByText(/verify your email/i).isVisible().catch(() => false)
    || await page.getByText(/magic link/i).isVisible().catch(() => false)
    || await page.getByText(/we've sent/i).isVisible().catch(() => false);
  if (isVerifyPage) {
    console.log(`  ✅ Form submitted — magic link sent to ${signupEmail}`);
    return signupPass;
  }

  // Otherwise check URL moved off /auth/
  const finalUrl = page.url();
  if (finalUrl.includes('/auth/')) {
    // Capture any error message visible on the page to help diagnose
    const errText = await page.evaluate(() => {
      const selectors = [
        '[class*="error" i]', '[class*="alert" i]', '[class*="toast" i]',
        '[role="alert"]', '[data-testid*="error"]', 'p[class*="red"]',
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (el && el.innerText?.trim()) return el.innerText.trim();
      }
      // Last resort: scan full body text for known error patterns
      const body = document.body.innerText;
      const match = body.match(/[^.!\n]*(something went wrong|unique|already.*exist|already.*taken|error|failed|blocked|invalid email|not allowed)[^.!\n]*/i);
      return match ? match[0].trim() : null;
    }).catch(() => null);

    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(t => t)
    ).catch(() => []);
    if (errText) console.warn(`  Page error message: "${errText}"`);
    console.warn(`  Visible buttons: ${btns.slice(0, 10).join(' | ')}`);

    // "Username and email must be unique" — this address is already registered.
    // Throw a retriable error so main() can get a fresh email and try again.
    const isEmailTaken = /unique|already.*exist|already.*taken/i.test(errText || '');
    const err = new Error(`Signup failed — ${errText || finalUrl}`);
    err.emailTaken = isEmailTaken;
    throw err;
  }
  console.log(`  ✅ Signed up as ${username} — session active (${finalUrl})`);
  return signupPass;
}

// ─── Poll inbox for RapidAPI magic link and click it ─────────────────────────

async function clickMagicLink(context, emailInfo) {
  const { email } = emailInfo;
  if (!_rapidKeys.length) {
    console.log('  RAPIDAPI_KEYS not set — skipping magic link polling.');
    return false;
  }

  console.log(`  Polling Gmailnator for magic link (up to 6 min)...`);
  const link = await pollGmailnatorForMagicLink(email, 360000);
  if (!link) {
    console.warn('  ⚠️ No magic link arrived within the timeout.');
    return false;
  }

  console.log(`  Magic link: ${link.slice(0, 80)}...`);
  const verifyPage = await context.newPage();
  await verifyPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await verifyPage.waitForTimeout(8000);
  const landedUrl = verifyPage.url();
  console.log(`  After magic link: ${landedUrl}`);
  await verifyPage.screenshot({ path: '/tmp/rapidapi-after-verify.png' }).catch(() => {});
  await verifyPage.close();

  if (!landedUrl.includes('/auth/')) {
    console.log('  ✅ Email verified — session active');
    return true;
  }
  console.warn('  ⚠️ Magic link redirected back to auth page');
  return false;
}

// ─── Subscribe to one API ─────────────────────────────────────────────────────

async function subscribeToAPI(page, link, name) {
  const pricingUrl = link.includes('/pricing') ? link : link.replace(/\/?$/, '') + '/pricing';
  console.log(`  → ${pricingUrl}`);

  await page.goto(pricingUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });

  // Wait for plan buttons to render (React SPA)
  try {
    await page.waitForSelector(
      'button:has-text("Start Free Plan"), button:has-text("Current Plan"), ' +
      'button:has-text("Choose This Plan"), button:has-text("Manage My Plan"), ' +
      'button:has-text("Subscribe")',
      { timeout: 12000 }
    );
  } catch { await page.waitForTimeout(3000); }

  // Already subscribed?
  const alreadySub = await page.locator(
    '[class*="CurrentPlan"], [class*="current-plan"], [class*="currentPlan"], ' +
    'button:has-text("Current Plan"), span:has-text("Current Plan"), ' +
    'button:has-text("Manage My Plan"), button:has-text("Manage Plan"), ' +
    'text=/current plan|already subscribed|manage my plan/i'
  ).first().isVisible().catch(() => false);
  if (alreadySub) {
    console.log(`    ✅ Already subscribed`);
    return true;
  }

  // Click subscribe button — prefer free tier
  const btnSelectors = [
    'button:has-text("Start Free Plan")',
    'a:has-text("Start Free Plan")',
    'button:has-text("Subscribe to Test")',
    'button:has-text("Subscribe")',
    'button:has-text("Select Plan")',
    'button:has-text("Start Free Trial")',
    'button:has-text("Get Started")',
    'a:has-text("Subscribe")',
    'button:has-text("Choose This Plan")',
  ];

  for (const sel of btnSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        const txt = (await btn.textContent().catch(() => '')).trim();
        console.log(`    Clicking: "${txt}"`);
        await btn.click();
        await page.waitForTimeout(3000);
        // Confirm modal if it pops
        try {
          await page.locator('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Subscribe")')
            .first().click({ timeout: 4000 });
          await page.waitForTimeout(2000);
        } catch {}
        console.log(`    ✅ Subscribed`);
        return true;
      }
    } catch {}
  }

  // Log visible button texts to help debug
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(t => t)
  ).catch(() => []);
  console.warn(`    ⚠️ Subscribe button not found | Visible buttons: ${btns.slice(0, 8).join(' | ')}`);
  return false;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) return;
  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: SLACK_CHANNEL, text },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch {}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Marie — RapidAPI Account Creator & Subscriber');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');
  if (!SIGNUP_PASSWORD)  throw new Error('SIGNUP_PASSWORD not set');
  if (!_rapidKeys.length && !process.env.SIGNUP_EMAIL) {
    throw new Error('RAPIDAPI_KEYS (or RAPIDAPI_KEY) must be set for Gmailnator');
  }

  // 1. Get a fresh real Gmail address from Gmailnator (each is a distinct base address)
  console.log('\nGenerating Gmailnator address...');
  let emailInfo = await createTempEmail();
  const { email } = emailInfo;

  // 2. Launch browser
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const newContext = () => browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  // context is declared here so it's accessible in the finally block
  let context = await newContext();

  let loginId = null;
  const subscribed = [];
  const failed = [];

  try {
    // 3. Sign up — retry up to 20 times with a fresh context each attempt
    //    (fresh context = no session cookies carried over between retries)
    console.log('\n── Phase 1: Sign up ──────────────────────────────────────');
    let actualPassword, signupEmail = email;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const page = await context.newPage();
      try {
        actualPassword = await signUp(page, signupEmail, SIGNUP_PASSWORD);
        await page.close();
        break; // success
      } catch (err) {
        await page.close();
        if (attempt < 20) {
          // Retry on ANY signup failure with a fresh context + new address.
          // RapidAPI surfaces three distinct rejections we've seen:
          //   - "Username and email must be unique" → dedup hit (email/username taken)
          //   - "Something went wrong"              → disposable-domain block, or transient
          //   - any other page error                → treat as retriable
          // Either way the recovery is the same: new browser context (no cookies),
          // new Gmailnator address. Only the final attempt rethrows.
          const reason = err.emailTaken ? 'email/username taken' : (err.message || 'unknown error').slice(0, 80);
          console.warn(`  Signup attempt ${attempt} failed — ${reason}. Fresh context + new address (attempt ${attempt + 1}/20)...`);
          await context.close();
          context = await newContext();
          const fresh = await createTempEmail();
          signupEmail = fresh.email;
          emailInfo = fresh; // update for magic link phase
        } else {
          throw err;
        }
      }
    }

    // 3b. Click magic link from verification email
    console.log('\n── Phase 1b: Verify email via magic link ─────────────────');
    await clickMagicLink(context, emailInfo);

    // 4. Subscribe to all APIs
    console.log('\n── Phase 2: Subscribe to all APIs ───────────────────────');
    const apis = await getAPIsToSubscribe();
    console.log(`  APIs to subscribe: ${apis.length}`);

    for (const api of apis) {
      const name = api.fields['Name'] || api.id;
      const link = api.fields['Link'];
      if (!link) { failed.push(name); continue; }

      console.log(`\n  API: ${name}`);
      const apiPage = await context.newPage();
      try {
        const ok = await subscribeToAPI(apiPage, link, name);
        if (ok) subscribed.push({ name, recordId: api.id });
        else    failed.push(name);
      } catch (err) {
        console.warn(`    ❌ ${name}: ${err.message}`);
        failed.push(name);
      }
      await apiPage.close();
      await new Promise(r => setTimeout(r, 1000));
    }

    // 5. Save to Airtable
    console.log('\n── Phase 3: Save to Airtable ────────────────────────────');
    loginId = await saveLogin(email, actualPassword);
    if (loginId) await saveCredential(email, actualPassword, loginId);

    // 6. Mark subscribed APIs + link login
    console.log(`\n  Linking ${subscribed.length} subscribed API(s) to login...`);
    for (const api of subscribed) {
      try {
        await markAPISubscribed(api.recordId, loginId);
      } catch (err) {
        console.warn(`  ⚠️ Could not update API record ${api.name}: ${err.message}`);
      }
    }

  } finally {
    await browser.close();
  }

  // 7. Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Account: ${email}`);
  console.log(`  Subscribed: ${subscribed.length} ✅   Failed: ${failed.length} ⚠️`);
  if (failed.length) console.log(`  Failed: ${failed.join(', ')}`);

  await postToSlack(
    `*Marie — RapidAPI Account Created* 🤖\n` +
    `Account: \`${email}\`\n` +
    `Subscribed: ${subscribed.length} APIs ✅   Failed: ${failed.length} ⚠️`
  );

  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
