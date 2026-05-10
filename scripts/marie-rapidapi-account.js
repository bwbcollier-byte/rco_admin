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
  // Allow overriding for local debugging — skip the temp-gmail API call
  if (process.env.SIGNUP_EMAIL) {
    console.log(`  Using provided email: ${process.env.SIGNUP_EMAIL}`);
    return process.env.SIGNUP_EMAIL;
  }
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

  // Strip '+tag' — RapidAPI rejects plus-aliased emails
  const signupEmail = email.replace(/\+[^@]+@/, '@');
  if (signupEmail !== email) console.log(`  Stripped email for signup: ${signupEmail}`);

  // Ensure password has a special character
  const signupPass = /[@;!$._#%^&*()\-]/.test(password) ? password : password + '!';
  if (signupPass !== password) console.log(`  Appended '!' to meet special-char requirement`);

  // Generate username from email prefix (alphanumeric only, max 20 chars, random suffix)
  const usernameStem = signupEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  const username = usernameStem + Math.floor(Math.random() * 9000 + 1000);
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

  // Check for "Verify your email" page — form submitted, magic link sent
  const isVerifyPage = await page.locator('text=/verify your email/i, text=/magic link/i').first()
    .isVisible({ timeout: 3000 }).catch(() => false);
  if (isVerifyPage) {
    console.log(`  ✅ Form submitted — magic link sent to ${signupEmail}`);
    return signupPass;
  }

  // Otherwise check URL moved off /auth/
  const finalUrl = page.url();
  if (finalUrl.includes('/auth/')) {
    const btns = await page.evaluate(() =>
      [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(t => t)
    ).catch(() => []);
    console.warn(`  Visible buttons: ${btns.slice(0, 10).join(' | ')}`);
    throw new Error(`Signup may have failed — still on auth page: ${finalUrl}`);
  }
  console.log(`  ✅ Signed up as ${username} — session active (${finalUrl})`);
  return signupPass;
}

// ─── Poll temp-gmail for RapidAPI magic link and click it ─────────────────────

async function pollGmailInbox(email, sinceTimestamp, timeoutMs = 360000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const res = await axios.get('https://temp-gmail.p.rapidapi.com/inbox', {
        params: { email, timestamp: sinceTimestamp },
        headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': TEMPGMAIL_HOST },
      });
      const messages = Array.isArray(res.data) ? res.data
        : Array.isArray(res.data?.messages) ? res.data.messages
        : Array.isArray(res.data?.emails)   ? res.data.emails : [];
      if (messages.length) return messages;
      console.log(`  Inbox empty — waiting... (${Math.round((Date.now()-start)/1000)}s)`);
    } catch (err) {
      if (err.response?.status !== 404) console.warn(`  Poll error: ${err.message}`);
      else console.log(`  Inbox empty (404) — waiting...`);
    }
  }
  return [];
}

async function fetchMessageBody(mid, email) {
  for (const params of [{ email, mid }, { mid }]) {
    try {
      const res = await axios.get('https://temp-gmail.p.rapidapi.com/message', {
        params,
        headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': TEMPGMAIL_HOST },
      });
      const body = res.data?.textBody || res.data?.htmlBody || res.data?.body
                || res.data?.text    || res.data?.html     || res.data?.content || '';
      if (body) return body;
    } catch (err) {
      if (err.response?.status !== 422 && err.response?.status !== 400) return '';
    }
  }
  return '';
}

async function clickMagicLink(context, email) {
  // Local testing (SIGNUP_EMAIL) — no temp-gmail access, skip automatically
  if (process.env.SIGNUP_EMAIL) {
    console.log('  [Local test] No inbox access — skipping magic link. Click it manually if needed.');
    return false;
  }

  const sinceTs = Math.floor(Date.now() / 1000) - 30;
  console.log(`  Polling inbox for magic link (up to 6 min)...`);
  const messages = await pollGmailInbox(email, sinceTs, 360000);

  for (const msg of messages) {
    const mid = msg.mid || msg.id || msg.messageId;
    const inlineBody = msg.textBody || msg.htmlBody || msg.body || msg.text || msg.html || '';
    const body = inlineBody || (mid ? await fetchMessageBody(mid, email) : '');

    // Find magic link — RapidAPI sends a link containing 'auth' and a token
    const linkMatch = body.match(/https?:\/\/rapidapi\.com\/[^\s"'<>]+/gi)
                   || body.match(/href="(https?:\/\/rapidapi\.com[^"]+)"/gi);
    if (!linkMatch) continue;

    const link = (linkMatch[0].startsWith('href=') ? linkMatch[0].replace(/href="([^"]+)"/, '$1') : linkMatch[0]).trim();
    console.log(`  Magic link: ${link.slice(0, 80)}...`);

    const verifyPage = await context.newPage();
    await verifyPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await verifyPage.waitForTimeout(8000);
    const landedUrl = verifyPage.url();
    console.log(`  After magic link: ${landedUrl}`);
    await verifyPage.close();

    if (!landedUrl.includes('/auth/')) {
      console.log('  ✅ Email verified — session active');
      return true;
    }
    console.warn('  ⚠️ Magic link redirected back to auth page');
    return false;
  }

  console.warn('  ⚠️ No magic link found in inbox');
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
  if (!RAPIDAPI_KEY && !process.env.SIGNUP_EMAIL) throw new Error('RAPIDAPI_KEY not set (or set SIGNUP_EMAIL to skip temp-gmail)');
  if (!SIGNUP_PASSWORD)  throw new Error('SIGNUP_PASSWORD not set');

  // 1. Get a fresh temp Gmail address
  console.log('\nGetting temp Gmail address...');
  const email = await getGmailAddress();

  // 2. Launch browser
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
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
    const actualPassword = await signUp(page, email, SIGNUP_PASSWORD);
    await page.close();

    // 3b. Click magic link from verification email
    console.log('\n── Phase 1b: Verify email via magic link ─────────────────');
    await clickMagicLink(context, email);

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
