/**
 * Marie — RapidAPI Account Creator & Subscriber
 *
 * 1. Creates a fresh private mailbox via Flash Temp Mail (each call → a brand-new
 *    address on a private domain, e.g. *@everythingispersonal.com — no shared
 *    pool, no stale verification emails from prior users)
 * 2. Signs up for a new RapidAPI account (uses pressSequentially — React form safe)
 * 3. Polls the Flash Temp Mail inbox for the verification email and clicks the magic link
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
 *   FLASH_TEMP_MAIL_KEY      (single RapidAPI key subscribed to flash-temp-mail.p.rapidapi.com)
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

// ─── Flash Temp Mail (fresh private mailboxes, not pool-shared) ──────────────
// flash-temp-mail.p.rapidapi.com creates a brand-new mailbox per call (e.g.
// `<random>@everythingispersonal.com`) with a private domain RapidAPI accepts.
// Unlike Gmailnator's shared pool, these are NEW addresses — no stale
// verification emails from previous users hijacking our magic-link click.
//
// Mailboxes expire after ~25 minutes. That's plenty for the signup → verify
// sub-flow; if the script needs to retry signup we create a fresh mailbox.
//
// Endpoints:
//   POST /mailbox/create?free_domains=false
//     → { email_address: "abc@everythingispersonal.com", expires_at: <unix>, success: true }
//   GET  /mailbox/emails-html?email_address=<addr>
//     → { emails: { ... }, expires_at: <unix>, success: true }
//
// Ben subscribed only one of his RapidAPI accounts to this API, so FLASH_TEMP_MAIL_KEY
// is the single key we use — no rotation.

const FLASH_HOST = 'flash-temp-mail.p.rapidapi.com';

// Populated at startup from Airtable Credentials (any RapidAPI API Key
// credential) with the FLASH_TEMP_MAIL_KEY env var as fallback. Multiple
// keys = larger daily quota since each Ben-owned RapidAPI account has its
// own per-key rate limit. Most keys will 403 because only some accounts
// are subscribed to flash-temp-mail, which is fine — rotation skips them.
let FLASH_KEYS = [];

function shuffledFlashKeys() {
  return [...FLASH_KEYS].sort(() => Math.random() - 0.5);
}

// Try every flash-temp-mail key in random order. Rotate on 403 (not subscribed
// to this API) and 429 (rate limited). Bail immediately on other errors —
// they're not key-related.
async function flashCall(method, path, body) {
  if (!FLASH_KEYS.length) throw new Error('No flash-temp-mail keys available');
  let lastErr;
  for (const key of shuffledFlashKeys()) {
    try {
      const res = await axios({
        method,
        url:     `https://${FLASH_HOST}${path}`,
        headers: {
          'x-rapidapi-key':  key,
          'x-rapidapi-host': FLASH_HOST,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        timeout: 10000,
        ...(body ? { data: body } : {}),
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      lastErr = err;
      if (status !== 403 && status !== 429) throw err;
    }
  }
  throw lastErr || new Error('All flash-temp-mail keys failed (403/429)');
}

async function fetchFlashTempMailKeys() {
  // Read Airtable Credentials where Credential Type = "API Key" AND the
  // record name mentions RapidAPI. Returns the Value column as the key set.
  const all = [];
  let offset;
  do {
    const params = {
      filterByFormula: "AND({Credential Type}='API Key', SEARCH('RapidAPI', {Name}))",
      'fields[]':      'Value',
      pageSize:        100,
      ...(offset ? { offset } : {}),
    };
    const res = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CREDS}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }, params }
    );
    all.push(...(res.data.records || []));
    offset = res.data.offset;
  } while (offset);

  const keys = all
    .map(r => (r.fields?.Value || '').trim())
    // RapidAPI keys are ~50 chars and contain "msh" in the middle. Skip
    // multi-line entries (those are notes, not raw keys) and exact dupes.
    .filter(v => v.length > 30 && !v.includes('\n') && /msh/.test(v))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  return keys;
}

async function createTempEmail() {
  if (process.env.SIGNUP_EMAIL) {
    console.log(`  Using provided email: ${process.env.SIGNUP_EMAIL}`);
    return { email: process.env.SIGNUP_EMAIL };
  }
  const data = await flashCall('POST', '/mailbox/create?free_domains=false', { not_required: 'not_required' });
  const email = data?.email_address;
  if (!email) throw new Error(`Unexpected flash-temp-mail create response: ${JSON.stringify(data)}`);
  console.log(`  Flash Temp Mail address: ${email} (expires ${new Date((data.expires_at||0)*1000).toISOString()})`);
  return { email };
}

// Pull every plausible body field out of a single Flash Temp Mail email object.
// The /emails-html endpoint can return either a list of objects or an object
// keyed by id — both shapes are normalised to an array of message objects.
function normaliseMessages(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object') return Object.entries(payload).map(([k, v]) =>
    v && typeof v === 'object' ? { id: k, ...v } : { id: k, body: String(v) }
  );
  return [];
}

async function fetchInboxMessages(email) {
  const data = await flashCall('GET', `/mailbox/emails-html?email_address=${encodeURIComponent(email)}`);
  return normaliseMessages(data?.emails);
}

function extractMagicLink(text) {
  if (!text) return null;
  const cleaned = text.replace(/=\r?\n/g, '').replace(/=3D/gi, '=');

  // The verify email has 3 `/ls/click` URLs:
  //   1. Header logo (→ rapidapi.com homepage — NOT verification)
  //   2. "Verify Email" CTA button (→ /auth/confirm-email — what we want)
  //   3. Footer link (→ rapidapi.com homepage)
  // Picking the first match silently clicks the logo and we end up on the
  // public homepage thinking we're verified. So: parse <a> tags, look at
  // each anchor's TEXT content, and prefer the one labelled Verify/Confirm.
  const anchors = [...cleaned.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const candidates = anchors
    .map(m => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }))
    .filter(a => /^https?:\/\/(?:[a-z0-9.-]*\.)?rapidapi\.com\//i.test(a.href));

  // Strong match: anchor text says "verify" / "confirm" / "activate"
  const verifyAnchor = candidates.find(a => /verify|confirm|activate/i.test(a.text));
  if (verifyAnchor) return verifyAnchor.href;

  // Fallback: an anchor whose href contains a verify/confirm path segment
  const verifyHref = candidates.find(a => /(?:confirm|verify|magic|activate)/i.test(a.href));
  if (verifyHref) return verifyHref.href;

  // Last resort: first /ls/click URL (legacy behaviour — kept for safety,
  // but will pick the header logo on RapidAPI's current template). Logged
  // so we notice when we're relying on the brittle path.
  const looseMatch = cleaned.match(/https?:\/\/url\d+\.rapidapi\.com\/ls\/click\?[^\s"'<>\n\r]+/i);
  if (looseMatch) {
    console.warn('  ⚠️ extractMagicLink falling back to first /ls/click URL (no anchor with Verify text found)');
    return looseMatch[0];
  }
  return null;
}

// Search every value of a message object for a RapidAPI link — different temp-mail
// services name the body field differently (`html`, `content`, `body`, `text`, ...).
function findLinkInMessage(msg) {
  if (!msg) return null;
  for (const v of Object.values(msg)) {
    if (typeof v === 'string') {
      const link = extractMagicLink(v);
      if (link) return link;
    }
  }
  return null;
}

async function pollFlashMailForMagicLink(email, timeoutMs = 360000) {
  // Verification emails empirically take ~30s–2min to arrive. Each poll is
  // one flash-temp-mail API credit, so polling aggressively from t=0 just
  // burns credits while the inbox is guaranteed empty. Wait a full minute
  // first, then poll every 15s. ~1+(360-60)/15 = 21 polls max vs ~36 before.
  const INITIAL_WAIT  = 60000;
  const POLL_INTERVAL = 15000;
  const start = Date.now();
  console.log(`  Polling Flash Temp Mail inbox for ${email}...`);
  console.log(`  Waiting ${INITIAL_WAIT / 1000}s before first poll (emails take 30s+ to arrive; saves API credits)`);
  await new Promise(r => setTimeout(r, INITIAL_WAIT));

  let firstDump = true;
  while (Date.now() - start < timeoutMs) {
    try {
      const messages = await fetchInboxMessages(email);
      if (messages.length && firstDump) {
        // One-shot debug dump of the message shape — helps if the body
        // field name ever changes. Logged at INFO so we see it once per run.
        const sample = { ...messages[0] };
        for (const k of Object.keys(sample)) {
          if (typeof sample[k] === 'string' && sample[k].length > 200) {
            sample[k] = sample[k].slice(0, 200) + '...';
          }
        }
        console.log(`  First message keys: ${Object.keys(messages[0]).join(', ')}`);
        firstDump = false;
      }
      for (const msg of messages) {
        const link = findLinkInMessage(msg);
        if (link) {
          console.log(`  Magic link found (subject: "${msg.subject || msg.Subject || '?'}")`);
          return link;
        }
        const subj = msg.subject || msg.Subject;
        if (subj) console.log(`  Email in inbox but no RapidAPI link (subject: "${subj}")`);
      }
      if (!messages.length) {
        console.log(`  Inbox empty — waiting... (${Math.round((Date.now() - start) / 1000)}s)`);
      }
    } catch (err) {
      console.warn(`  Flash Temp Mail poll error: ${err.response?.status || ''} ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }
  return null;
}

// ─── Airtable ─────────────────────────────────────────────────────────────────

async function getAPIsToSubscribe() {
  // Airtable returns 100 records per page by default; paginate via `offset`
  // tokens until exhausted so we pick up every API flagged Subscribe via Kondo.
  const all = [];
  let offset;
  do {
    const res = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}`,
      {
        params: {
          filterByFormula: `{Subscribe via Kondo}`,
          fields: ['Name', 'Link'],
          pageSize: 100,
          ...(offset ? { offset } : {}),
        },
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
      }
    );
    all.push(...(res.data.records || []));
    offset = res.data.offset;
  } while (offset);
  return all;
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

  // Flash Temp Mail returns a brand-new mailbox per call, so we pass it
  // straight through to RapidAPI. (Earlier we tried Gmail + addressing, then
  // Gmailnator's shared Gmail pool — both failed because RapidAPI strips
  // +tags and dots before dedup, and Gmailnator's recycled inboxes carried
  // stale verify emails that hijacked the magic-link click.)
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
  if (!FLASH_KEYS.length) {
    console.log('  No flash-temp-mail keys loaded — skipping magic link polling.');
    return false;
  }

  console.log(`  Polling Flash Temp Mail for magic link (up to 6 min)...`);
  const link = await pollFlashMailForMagicLink(email, 360000);
  if (!link) {
    console.warn('  ⚠️ No magic link arrived within the timeout.');
    return false;
  }

  console.log(`  Magic link: ${link.slice(0, 80)}...`);
  const verifyPage = await context.newPage();
  await verifyPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // SendGrid `/ls/click` URLs do a JS redirect after a brief delay; wait long
  // enough for that to settle before checking final state.
  await verifyPage.waitForTimeout(8000);
  const landedUrl = verifyPage.url();
  console.log(`  After magic link: ${landedUrl}`);
  await verifyPage.screenshot({ path: '/tmp/rapidapi-after-verify.png' }).catch(() => {});

  // Don't trust the URL alone — RapidAPI's public homepage is /, which used
  // to pass the `!landedUrl.includes('/auth/')` check even though the user
  // is logged out. Probe a real authenticated page and confirm we don't get
  // bounced to login. The dashboard or /developer/account both require auth.
  await verifyPage.goto('https://rapidapi.com/developer/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await verifyPage.waitForTimeout(3000);
  const dashboardUrl = verifyPage.url();
  await verifyPage.screenshot({ path: '/tmp/rapidapi-dashboard-check.png' }).catch(() => {});
  await verifyPage.close();

  // If we got bounced to /auth/login or /auth/sign-in, the magic link didn't
  // actually authenticate us. Treat as verification failure.
  if (/\/auth\/(?:login|sign-in|sign-up)/i.test(dashboardUrl)) {
    console.warn(`  ⚠️ Magic link did not authenticate — dashboard bounced to ${dashboardUrl}`);
    return false;
  }
  if (dashboardUrl.includes('/developer/')) {
    console.log(`  ✅ Email verified — session active (dashboard: ${dashboardUrl})`);
    return true;
  }
  console.warn(`  ⚠️ Unexpected post-verify URL: ${dashboardUrl} (treating as not verified)`);
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

// Create one RapidAPI account end-to-end: signup → verify → save → subscribe.
// Returns { email, subscribed: [], failed: [] }. Throws on unrecoverable failure.
async function createOneAccount(browser, apis) {
  // 1. Create a fresh private mailbox via Flash Temp Mail
  console.log('\nCreating Flash Temp Mail mailbox...');
  let emailInfo = await createTempEmail();
  const { email } = emailInfo;

  const newContext = () => browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

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
          // new Flash Temp Mail mailbox. Only the final attempt rethrows.
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
    const verified = await clickMagicLink(context, emailInfo);
    if (!verified) {
      throw new Error('Email verification failed — bailing before subscriptions to avoid creating a half-broken account record');
    }

    // 4. Save Login + Credential to Airtable NOW that the account is verified.
    //    Phase 2 (100 API subscriptions) takes 10+ minutes — if the script
    //    gets killed mid-loop we still want the credentials persisted so we
    //    can log into the account by hand.
    console.log('\n── Phase 1c: Save Login + Credential to Airtable ────────');
    loginId = await saveLogin(email, actualPassword);
    if (loginId) await saveCredential(email, actualPassword, loginId);

    // 5. Subscribe to all APIs, flushing API-to-Login links in batches of 10
    //    so that a mid-run abort leaves a usable partial record.
    console.log('\n── Phase 2: Subscribe to all APIs ───────────────────────');
    console.log(`  APIs to subscribe: ${apis.length}`);

    const LINK_BATCH_SIZE = 10;
    let pendingLinks = [];
    async function flushPendingLinks() {
      if (!pendingLinks.length || !loginId) return;
      const batch = pendingLinks;
      pendingLinks = [];
      console.log(`  Linking ${batch.length} subscribed API(s) to login...`);
      for (const api of batch) {
        try {
          await markAPISubscribed(api.recordId, loginId);
        } catch (err) {
          console.warn(`  ⚠️ Could not link ${api.name}: ${err.message}`);
        }
      }
    }

    // Reuse one page across all subscriptions. The auth context (cookies) is on
    // `context` so it persists either way, but reusing the page avoids ~1-2s
    // of tab-creation overhead per iteration (~2 min total for 100 APIs).
    // If a page error breaks the tab state, we close + reopen and continue.
    let apiPage = await context.newPage();
    for (const api of apis) {
      const name = api.fields['Name'] || api.id;
      const link = api.fields['Link'];
      if (!link) { failed.push(name); continue; }

      console.log(`\n  API: ${name}`);
      try {
        const ok = await subscribeToAPI(apiPage, link, name);
        if (ok) {
          subscribed.push({ name, recordId: api.id });
          pendingLinks.push({ name, recordId: api.id });
          if (pendingLinks.length >= LINK_BATCH_SIZE) await flushPendingLinks();
        } else {
          failed.push(name);
        }
      } catch (err) {
        console.warn(`    ❌ ${name}: ${err.message}`);
        failed.push(name);
        // If the page is in a broken state (closed, crashed, etc), spin up a new one
        if (apiPage.isClosed()) {
          apiPage = await context.newPage();
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    // Final flush — anything left in the partial last batch
    await flushPendingLinks();
    await apiPage.close();

    // Per-account summary + Slack ping
    console.log('\n' + '─'.repeat(60));
    console.log(`Account: ${email}`);
    console.log(`Subscribed: ${subscribed.length} ✅   Failed: ${failed.length} ⚠️`);
    if (failed.length) console.log(`Failed: ${failed.join(', ')}`);
    await postToSlack(
      `*Marie — RapidAPI Account Created* 🤖\n` +
      `Account: \`${email}\`\n` +
      `Subscribed: ${subscribed.length} APIs ✅   Failed: ${failed.length} ⚠️`
    );

    return { email, subscribed, failed };
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Marie — RapidAPI Account Creator & Subscriber');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');
  if (!SIGNUP_PASSWORD)  throw new Error('SIGNUP_PASSWORD not set');

  // Load rotation pool of flash-temp-mail keys from Airtable + the env var.
  // The FLASH_TEMP_MAIL_KEY env value is *always* included (deduped) so the
  // known-working key isn't lost just because Airtable hasn't been populated
  // with it yet. Most Airtable keys will 403 (their account isn't subscribed
  // to flash-temp-mail) — rotation skips them, which is fine.
  console.log('\nLoading flash-temp-mail keys from Airtable...');
  try {
    FLASH_KEYS = await fetchFlashTempMailKeys();
  } catch (err) {
    console.warn(`  ⚠️ Airtable key fetch failed: ${err.message}`);
    FLASH_KEYS = [];
  }
  const envKey = (process.env.FLASH_TEMP_MAIL_KEY || '').trim();
  if (envKey && !FLASH_KEYS.includes(envKey)) FLASH_KEYS.push(envKey);
  console.log(`  ${FLASH_KEYS.length} key(s) available for rotation (${FLASH_KEYS.length ? FLASH_KEYS.map(k => k.slice(0, 8) + '…').join(', ') : 'none'})`);
  if (!FLASH_KEYS.length && !process.env.SIGNUP_EMAIL) {
    throw new Error('No flash-temp-mail keys (Airtable Credentials + FLASH_TEMP_MAIL_KEY env both empty)');
  }

  // Fetch the APIs list once at startup — same list applies to every account
  // we create in this run, no point re-querying for each.
  const apis = await getAPIsToSubscribe();
  console.log(`  ${apis.length} APIs flagged Subscribe via Kondo`);

  // Launch browser ONCE — reused across all accounts. Each account gets its
  // own fresh BrowserContext so cookies/fingerprint don't carry between them.
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // Outer loop: keep creating accounts until the user kills the process or
  // we hit N consecutive failures (something's wrong, stop). MAX_ACCOUNTS
  // hard-caps a single invocation so a runaway loop can't burn unlimited
  // RapidAPI signups; set MAX_ACCOUNTS env to override.
  const MAX_ACCOUNTS                = parseInt(process.env.MAX_ACCOUNTS || '50', 10);
  const MAX_CONSECUTIVE_FAILURES    = 5;
  const PAUSE_BETWEEN_ACCOUNTS_MS   = 30000;
  let runIndex            = 0;
  let consecutiveFailures = 0;
  const totals            = { ok: 0, fail: 0, subscribed: 0, failedSubs: 0 };

  try {
    while (runIndex < MAX_ACCOUNTS) {
      runIndex++;
      console.log('\n' + '#'.repeat(60));
      console.log(`# ACCOUNT ${runIndex}/${MAX_ACCOUNTS}`);
      console.log('#'.repeat(60));
      try {
        const result = await createOneAccount(browser, apis);
        totals.ok++;
        totals.subscribed += result.subscribed.length;
        totals.failedSubs += result.failed.length;
        consecutiveFailures = 0;
      } catch (err) {
        totals.fail++;
        consecutiveFailures++;
        console.error(`\n❌ Account ${runIndex} failed: ${err.message}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`\nStopping outer loop — ${consecutiveFailures} consecutive failures (something's wrong upstream)`);
          break;
        }
      }
      // Brief pause between accounts — keeps RapidAPI from seeing a tight burst.
      if (runIndex < MAX_ACCOUNTS) {
        console.log(`\n⏸  Pausing ${PAUSE_BETWEEN_ACCOUNTS_MS / 1000}s before next account...`);
        await new Promise(r => setTimeout(r, PAUSE_BETWEEN_ACCOUNTS_MS));
      }
    }
  } finally {
    await browser.close();
  }

  // Final summary across all accounts created this run
  console.log('\n' + '='.repeat(60));
  console.log('Run Summary');
  console.log('='.repeat(60));
  console.log(`  Accounts created : ${totals.ok}`);
  console.log(`  Accounts failed  : ${totals.fail}`);
  console.log(`  Total subscribed : ${totals.subscribed}`);
  console.log(`  Total failed subs: ${totals.failedSubs}`);
  await postToSlack(
    `*Marie — Run Complete* 🤖\n` +
    `Accounts created: ${totals.ok}   Failed: ${totals.fail}\n` +
    `Total subscriptions: ${totals.subscribed} ✅   Failed: ${totals.failedSubs} ⚠️`
  );
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
