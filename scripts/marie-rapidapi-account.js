/**
 * Marie — RapidAPI Account Creator & Subscriber
 *
 * 1. Creates a fresh temp Gmail alias (via temp-gmail RapidAPI)
 * 2. Signs up for a new RapidAPI account (uses pressSequentially — React form safe)
 * 3. Verifies the session is active (URL-based check)
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
 *   RAPIDAPI_KEY             (used for temp Gmail API)
 *   SIGNUP_PASSWORD
 *   SLACK_BOT_TOKEN          (optional)
 *   SLACK_CHANNEL_AI_ENGINEERING (optional)
 */

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

const RAPIDAPI_KEY     = process.env.RAPIDAPI_KEY;
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

// Temp Gmail settings
const TEMPGMAIL_HOST = 'temp-gmail.p.rapidapi.com';
const TEMPGMAIL_PASS = 'abc123';

const DEFAULTS = { firstName: 'Ben', lastName: 'Collier', company: 'Rascals Inc' };

// ─── Temp Gmail ───────────────────────────────────────────────────────────────

async function getGmailAddress() {
  const res = await axios.get('https://temp-gmail.p.rapidapi.com/random', {
    params: { type: 'alias', password: TEMPGMAIL_PASS },
    headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': TEMPGMAIL_HOST },
  });
  const email = res.data.email || res.data.gmail || res.data.address;
  if (!email) throw new Error(`Unexpected temp Gmail response: ${JSON.stringify(res.data)}`);
  console.log(`  Temp Gmail address: ${email}`);
  return email;
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

  await page.screenshot({ path: '/tmp/rapidapi-signup-before.png' }).catch(() => {});

  // Fill email — use pressSequentially (React form needs real keyboard events)
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  if (!await emailInput.isVisible({ timeout: 8000 }).catch(() => false)) {
    throw new Error('Email field not found on signup page');
  }
  await emailInput.click();
  await emailInput.pressSequentially(email, { delay: 60 });
  await page.waitForTimeout(300);

  // Fill password
  const passInput = page.locator('input[type="password"]').first();
  if (await passInput.isVisible().catch(() => false)) {
    await passInput.click();
    await passInput.pressSequentially(password, { delay: 60 });
    await page.waitForTimeout(300);
  }

  // Fill name fields if present
  await page.locator('input[name="firstName"], input[placeholder*="first" i]').first().fill(DEFAULTS.firstName).catch(() => {});
  await page.locator('input[name="lastName"],  input[placeholder*="last" i]').first().fill(DEFAULTS.lastName).catch(() => {});

  // Tick terms checkbox
  await page.locator('input[type="checkbox"]').first().check().catch(() => {});

  await page.screenshot({ path: '/tmp/rapidapi-signup-filled.png' }).catch(() => {});

  // Submit — try multiple patterns RapidAPI uses
  let submitted = false;
  const submitSelectors = [
    'button[type="submit"]',
    'button:has-text("Sign Up")',
    'button:has-text("Create Account")',
    'button:has-text("Get Started")',
    '[role="button"]:has-text("Sign Up")',
    'form button',
  ];
  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        submitted = true;
        console.log(`  Submitted via: ${sel}`);
        break;
      }
    } catch {}
  }
  if (!submitted) throw new Error('Submit button not found on signup page');

  await page.waitForTimeout(8000);
  await page.screenshot({ path: '/tmp/rapidapi-signup-after.png' }).catch(() => {});

  // Verify session — success = URL moved away from /auth/
  const finalUrl = page.url();
  if (finalUrl.includes('/auth/')) {
    throw new Error(`Signup may have failed — still on auth page: ${finalUrl}`);
  }
  console.log(`  ✅ Signed up (${finalUrl})`);
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
  if (!RAPIDAPI_KEY)     throw new Error('RAPIDAPI_KEY not set');
  if (!SIGNUP_PASSWORD)  throw new Error('SIGNUP_PASSWORD not set');

  // 1. Get a fresh temp Gmail address
  console.log('\nGetting temp Gmail address...');
  const email = await getGmailAddress();

  // 2. Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  let loginId = null;
  const subscribed = [];
  const failed = [];

  try {
    const page = await context.newPage();

    // 3. Sign up
    console.log('\n── Phase 1: Sign up ──────────────────────────────────────');
    await signUp(page, email, SIGNUP_PASSWORD);
    await page.close();

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
    loginId = await saveLogin(email, SIGNUP_PASSWORD);
    if (loginId) await saveCredential(email, SIGNUP_PASSWORD, loginId);

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
