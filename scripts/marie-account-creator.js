/**
 * Marie — Account Creator
 *
 * Architecture: PER-SITE temp emails (via Temp Mail API / Privatix).
 * Each site signs up with its own randomly-chosen domain address, increasing
 * the chance that at least one domain delivers verification mail. After Phase 1
 * (all forms submitted), Phase 2 polls every unique inbox in parallel and clicks
 * all verification links. Phase 3 subscribes to curated RapidAPI APIs while the
 * browser session is still live. Phase 4 saves credentials.
 *
 * Secrets required:
 *   RAPIDAPI_KEY  (used for both Temp Mail and RapidAPI)
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING
 *   SIGNUP_PASSWORD
 */

const { chromium } = require('playwright');
const axios = require('axios');
const crypto = require('crypto');

// Auto-load .env for local runs; no-op on GitHub Actions.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

// ─── Config ───────────────────────────────────────────────────────────────────

const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID  = 'app6biS7yjV6XzFVG';
const AIRTABLE_QUEUE    = 'tbl0mLelR78YJjKwV';   // Signup Queue
const AIRTABLE_LOGINS   = 'tbldJkG11gY1W3jTf';   // Logins
const AIRTABLE_CREDS    = 'tblvBr6RIc7bcGXYJ';   // Credentials
const AIRTABLE_APIS     = 'tblMb9HFyKcnQ7aKb';   // APIs

const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY;
// Flash Temp Mail requires a key subscribed to flash-temp-mail.p.rapidapi.com.
// Falls back to RAPIDAPI_KEY so GHA works if only one key var is set.
const FLASH_TEMP_MAIL_KEY = process.env.FLASH_TEMP_MAIL_KEY || RAPIDAPI_KEY;
const TEMPGMAIL_HOST    = 'temp-gmail.p.rapidapi.com';
const TEMPGMAIL_PASS    = 'abc123'; // password for the temp Gmail alias — must be consistent per session


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

// ─── Temp Gmail API (temp-gmail.p.rapidapi.com) ───────────────────────────────

/**
 * GET /random — creates a temporary Gmail alias and returns its address.
 * Response shape: { email: "xyz@gmail.com", ... }
 */
async function getGmailAddress() {
  let res;
  try {
    res = await axios.get('https://temp-gmail.p.rapidapi.com/random', {
      params: { type: 'alias', password: TEMPGMAIL_PASS },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': TEMPGMAIL_HOST,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Gmail API /random failed (${err.response?.status}): ${detail}`);
  }
  console.log(`  Gmail API response: ${JSON.stringify(res.data)}`);
  const email = res.data.email || res.data.gmail || res.data.address || (typeof res.data === 'string' ? res.data : null);
  if (!email) throw new Error(`Unexpected Gmail API response: ${JSON.stringify(res.data)}`);
  console.log(`  Temp Gmail address: ${email}`);
  return email;
}

/**
 * GET /inbox — polls the Gmail alias inbox since a given Unix timestamp.
 * Keeps polling until messages arrive or timeout is reached.
 * Response shape: array of metadata objects (mid, textSubject, textFrom, textDate — no body).
 */
async function pollGmailInbox(email, sinceTimestamp, timeoutMs = 600000) {
  console.log(`  Polling Gmail inbox for ${email} (since ${sinceTimestamp})...`);
  const SETTLE_MS = 300000; // keep polling 5 min after first message to catch late senders
  const start = Date.now();
  let allMessages = [];
  let firstMessageAt = null;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const res = await axios.get('https://temp-gmail.p.rapidapi.com/inbox', {
        params: { email, timestamp: sinceTimestamp },
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': TEMPGMAIL_HOST,
          'Content-Type': 'application/json',
        },
      });
      const messages = Array.isArray(res.data) ? res.data
        : Array.isArray(res.data?.messages) ? res.data.messages
        : Array.isArray(res.data?.emails)   ? res.data.emails
        : [];
      if (messages.length > allMessages.length) {
        console.log(`  Gmail inbox: ${messages.length} message(s) (+${messages.length - allMessages.length} new)`);
        if (!firstMessageAt) firstMessageAt = Date.now();
        allMessages = messages;
      } else if (messages.length > 0) {
        console.log(`  Gmail inbox: ${messages.length} message(s) — no new arrivals`);
      } else {
        console.log(`  No messages yet...`);
      }
      if (firstMessageAt && Date.now() - firstMessageAt >= SETTLE_MS) {
        console.log(`  Settle window complete — processing ${allMessages.length} message(s)`);
        return allMessages;
      }
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`  Inbox empty (404), waiting...`);
      } else {
        console.warn(`  Gmail poll error: ${err.message}`);
      }
    }
  }
  console.log(`  Poll timeout — returning ${allMessages.length} message(s)`);
  return allMessages;
}

/**
 * GET /message — fetches full body of a single Gmail message by its mid.
 * The inbox endpoint only returns metadata; this gets the actual content.
 * Tries several param combinations since the API docs are sparse.
 */
async function fetchGmailMessageBody(mid, email) {
  // Documented params: email + mid (no password)
  const attempts = [
    { email, mid },
    { mid },
  ];

  for (const params of attempts) {
    try {
      const res = await axios.get('https://temp-gmail.p.rapidapi.com/message', {
        params,
        headers: {
          'x-rapidapi-key': RAPIDAPI_KEY,
          'x-rapidapi-host': TEMPGMAIL_HOST,
          'Content-Type': 'application/json',
        },
      });
      console.log(`  Message body keys: ${Object.keys(res.data || {}).join(', ')}`);
      const body = res.data?.textBody || res.data?.htmlBody || res.data?.body
                || res.data?.text    || res.data?.html     || res.data?.content
                || res.data?.message || res.data?.snippet;
      if (body) return body;
      // Log full response if we can't find a body field
      console.log(`  Full message response: ${JSON.stringify(res.data).slice(0, 400)}`);
      return JSON.stringify(res.data);
    } catch (err) {
      if (err.response?.status !== 422 && err.response?.status !== 400) {
        console.warn(`  Could not fetch message body for mid ${mid}: ${err.response?.status} ${err.message}`);
        return '';
      }
      // 422/400 = wrong params, try next combination
    }
  }
  console.warn(`  All param combinations failed for mid ${mid}`);
  return '';
}

// ─── Flash Temp Mail API (flash-temp-mail.p.rapidapi.com) — fallback ─────────

const FLASHMAIL_HOST = 'flash-temp-mail.p.rapidapi.com';

/**
 * POST /mailbox/create — creates a fresh temp mailbox, returns its address.
 * Response shape: { email_address: "xxx@flashmail.my", ... }
 */
async function createFlashMailbox() {
  let res;
  try {
    res = await axios.post(
      'https://flash-temp-mail.p.rapidapi.com/mailbox/create',
      { not_required: 'not_required' },
      {
        params: { free_domains: false },
        headers: {
          'x-rapidapi-key': FLASH_TEMP_MAIL_KEY,
          'x-rapidapi-host': FLASHMAIL_HOST,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Flash Mail /mailbox/create failed (${err.response?.status}): ${detail}`);
  }
  console.log(`  Flash Mail API response: ${JSON.stringify(res.data)}`);
  const email = res.data.email_address || res.data.email || res.data.address;
  if (!email) throw new Error(`Unexpected Flash Mail response: ${JSON.stringify(res.data)}`);
  console.log(`  Flash Mail address: ${email}`);
  return email;
}

/**
 * GET /mailbox/emails-html — polls the Flash mailbox until messages arrive.
 * Continues polling for SETTLE_MS after first messages arrive to catch late senders.
 */
async function pollFlashInbox(email, timeoutMs = 600000) {
  console.log(`  Polling Flash Mail inbox for ${email}...`);
  const SETTLE_MS = 300000; // keep polling 5 min after first message to catch late arrivals
  const start = Date.now();
  let allMessages = [];
  let firstMessageAt = null;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const res = await axios.get('https://flash-temp-mail.p.rapidapi.com/mailbox/emails-html', {
        params: { email_address: email },
        headers: {
          'x-rapidapi-key': FLASH_TEMP_MAIL_KEY,
          'x-rapidapi-host': FLASHMAIL_HOST,
          'Content-Type': 'application/json',
        },
      });
      const messages = Array.isArray(res.data) ? res.data
        : Array.isArray(res.data?.emails)   ? res.data.emails
        : Array.isArray(res.data?.messages) ? res.data.messages
        : [];

      if (messages.length > allMessages.length) {
        console.log(`  Inbox: ${messages.length} message(s) (+${messages.length - allMessages.length} new)`);
        if (!firstMessageAt) {
          firstMessageAt = Date.now();
          // Log structure once so we know field names
          console.log(`  Flash msg keys: ${Object.keys(messages[0]).join(', ')}`);
        }
        allMessages = messages;
      } else if (messages.length > 0) {
        console.log(`  Inbox: ${messages.length} message(s) — no new arrivals`);
      } else {
        console.log(`  No messages yet...`);
      }

      // Return once settle time has passed after first message
      if (firstMessageAt && Date.now() - firstMessageAt >= SETTLE_MS) {
        console.log(`  Settle window complete — processing ${allMessages.length} message(s)`);
        return allMessages;
      }
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`  Inbox empty (404), waiting...`);
      } else {
        console.warn(`  Flash Mail poll error: ${err.message}`);
      }
    }
  }
  console.log(`  Poll timeout — returning ${allMessages.length} message(s)`);
  return allMessages;
}

/**
 * Polls the Flash inbox for messages with timestamp > sinceUnixTs.
 * Used in Phase 4 re-auth flows where we need only NEW messages (after a fresh
 * magic link is requested), not the full historical inbox.
 */
async function pollFlashInboxSince(email, sinceUnixTs, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      const res = await axios.get('https://flash-temp-mail.p.rapidapi.com/mailbox/emails-html', {
        params: { email_address: email },
        headers: {
          'x-rapidapi-key': FLASH_TEMP_MAIL_KEY,
          'x-rapidapi-host': FLASHMAIL_HOST,
          'Content-Type': 'application/json',
        },
      });
      const messages = Array.isArray(res.data) ? res.data
        : Array.isArray(res.data?.emails)   ? res.data.emails
        : Array.isArray(res.data?.messages) ? res.data.messages
        : [];
      const newMsgs = messages.filter(m => (m.timestamp || 0) > sinceUnixTs);
      if (newMsgs.length > 0) {
        console.log(`  Flash inbox: found ${newMsgs.length} new message(s) since re-auth request`);
        return newMsgs;
      }
      console.log(`  Flash inbox: no new messages yet (since ts=${sinceUnixTs})...`);
    } catch (err) {
      console.warn(`  Flash poll error: ${err.message}`);
    }
  }
  console.warn('  Flash re-auth poll timed out — no new messages arrived');
  return [];
}

// ─── Email provider router ────────────────────────────────────────────────────

/**
 * Try Gmail first (real gmail.com address — universally trusted by SMTP filters).
 * Fall back to Flash Temp Mail if Gmail API fails.
 * Returns { email, service } so Phase 2 knows which inbox to poll.
 *
 * Gmail is primary because Flash domains (sendhelp.mom, step-sis.help, etc.) are
 * on spam blocklists and get silently rejected by Tavily, OpenRouter, TMDB, xAI, etc.
 */
async function getBatchEmail() {
  try {
    const email = await getGmailAddress();
    return { email, service: 'gmail' };
  } catch (err) {
    console.warn(`  ⚠️ Gmail API failed: ${err.message}`);
    console.log('  → Falling back to Flash Temp Mail...');
    const email = await createFlashMailbox();
    return { email, service: 'flash' };
  }
}

/**
 * Poll whichever inbox service was used to get the batch email.
 */
async function pollBatchInbox(email, service, startTimestamp, timeoutMs = 600000) {
  if (service === 'flash') return pollFlashInbox(email, timeoutMs);
  return pollGmailInbox(email, startTimestamp, timeoutMs);
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

// ─── Airtable — Signup Queue ──────────────────────────────────────────────────

async function getPendingSignups() {
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_QUEUE}`,
    {
      params: {
        // Run everything except sites explicitly marked Failed (e.g. Qwen — needs phone SMS)
        // Done sites are retried each run to create fresh accounts
        filterByFormula: `{Status} != "Failed"`,
        fields: ['Name', 'URL', 'Category', 'Status', 'Notes', 'Repeatable'],
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

async function saveToAirtable(siteName, email, password, notes, status = 'Active') {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save to Airtable: ${siteName} / ${email} (status: ${status})`);
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
          fldcZ9nAY8GD2OZW8: status,
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
  // Only pulls APIs where "Subscribe via Kondo" is checked AND not yet subscribed
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}`,
    {
      params: {
        filterByFormula: `AND({Subscribe via Kondo}, NOT({Subscribed}))`,
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

async function linkLoginToSubscribedAPIs(subscribedApiRecordIds, loginId) {
  // Called in Phase 4 after the RapidAPI Login record is created.
  // Stamps each subscribed API row with the linked Login so we know which
  // RapidAPI account is tied to each subscription.
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would link login ${loginId} to ${subscribedApiRecordIds.length} API record(s)`);
    return;
  }
  for (const recordId of subscribedApiRecordIds) {
    try {
      await axios.patch(
        `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}/${recordId}`,
        { fields: { 'Subscribed Accounts': [loginId] } },
        { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      console.warn(`  ⚠️ Could not link login to API record ${recordId}: ${err.response?.data?.error || err.message}`);
    }
  }
  console.log(`  ✅ Linked RapidAPI login to ${subscribedApiRecordIds.length} subscribed API record(s)`);
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
  try { await page.screenshot({ path: `/tmp/marie-signup-${siteId}-${label}.png` }); } catch {}
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

  const subscribed = []; // { name, recordId }
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
          subscribed.push({ name, recordId: api.id });
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
        subscribed.push({ name, recordId: api.id });
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

async function signUpGroq(page, site, email, password) {
  // Groq uses Clerk: email-only first step, then sends a magic link (no password entry)
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  // Look for "Sign up" tab/link if on the login page
  const signUpLink = page.locator('a:has-text("Sign up"), button:has-text("Sign up")').first();
  if (await signUpLink.isVisible().catch(() => false)) {
    await signUpLink.click();
    await page.waitForTimeout(2000);
  }

  // Fill email field
  const emailInput = page.locator('input[type="email"], input[name*="email" i]').first();
  if (!await emailInput.isVisible().catch(() => false)) {
    return { success: false, reason: 'Groq: email input not found' };
  }
  await emailInput.fill(email);
  await page.waitForTimeout(500);

  // Submit — Clerk uses "Continue" button
  await playwrightClickSubmit(page);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-after.png` });

  // Groq sends a magic link — always needs verification regardless of page text
  console.log('  Groq: magic link sent, flagging for Phase 2 verification');
  return { success: true, needsVerification: true };
}

async function signUpLastFM(page, site, email, password) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  // Username derived from email prefix (max 15 chars, alphanumeric + _ -)
  const username = email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 15);

  // Fill fields with Playwright (handles React-bound inputs better than JS fill)
  await page.locator('input[name="username"], #id_username').fill(username).catch(() => {});
  await page.locator('input[type="email"], input[name*="email" i]').first().fill(email).catch(() => {});
  // Last FM has two password fields (password + confirm)
  const pwFields = await page.locator('input[type="password"]').all();
  for (const f of pwFields) await f.fill(password).catch(() => {});

  // Date of birth — Last FM uses <select> dropdowns
  await page.locator('select[name="day"], #id_dob_day').selectOption('15').catch(() => {});
  await page.locator('select[name="month"], #id_dob_month').selectOption('6').catch(() => {});
  await page.locator('select[name="year"], #id_dob_year').selectOption('1990').catch(() => {});

  // Gender optional — prefer not to say
  await page.locator('select[name="gender"]').selectOption('n').catch(() => {});

  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-filled.png` });

  // Submit
  const submitted = await playwrightClickSubmit(page);
  if (!submitted) return { success: false, reason: 'Submit button not found' };

  await page.waitForTimeout(5000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-after.png` });

  const text = await page.evaluate(() => document.body.innerText);
  // Last FM CAPTCHA will block — detect and report cleanly
  if (/captcha|robot|not a human/i.test(text)) {
    return { success: false, reason: 'Last FM: CAPTCHA challenge — needs manual signup' };
  }
  // Tightened regex — avoids false positive from nav links like "Already have an account?"
  const hasError = /\b(error|invalid)\b.{0,60}\b(email|password|username|field)\b|\b(already (registered|exists|taken))\b|try again later/i.test(text);
  if (hasError) {
    const m = text.match(/(error|invalid|already (registered|exists|taken))[^\n]{0,100}/i);
    return { success: false, reason: m?.[0] || 'Error detected on page' };
  }
  return { success: true, needsVerification: true };
}

async function signUpRapidAPI(page, site, email, password) {
  await page.goto(site.fields['URL'], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-before.png` });

  // RapidAPI uses React — must use pressSequentially (not JS value assignment) to trigger
  // React's synthetic events, otherwise the form submits with empty fields.
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passInput  = page.locator('input[type="password"]').first();

  if (!await emailInput.isVisible().catch(() => false)) {
    return { success: false, reason: 'RapidAPI signup: email field not found' };
  }
  await emailInput.click();
  await emailInput.pressSequentially(email, { delay: 60 });
  await page.waitForTimeout(300);

  if (await passInput.isVisible().catch(() => false)) {
    await passInput.click();
    await passInput.pressSequentially(password, { delay: 60 });
    await page.waitForTimeout(300);
  }

  // Also fill first/last name if present (some RapidAPI signup variants ask for it)
  await page.locator('input[name="firstName"], input[placeholder*="first" i]').first().fill(DEFAULTS.firstName).catch(() => {});
  await page.locator('input[name="lastName"],  input[placeholder*="last" i]').first().fill(DEFAULTS.lastName).catch(() => {});

  // Tick terms checkbox
  await page.locator('input[type="checkbox"]').first().check().catch(() => {});

  const filled = 1; // we filled at least email
  console.log(`  Filled email + password via pressSequentially`);

  // RapidAPI may have a terms checkbox — already handled by fillStandardForm
  // Use Playwright click for the submit (handles React SPAs better)
  let submitted = await playwrightClickSubmit(page);

  // Extra fallbacks — RapidAPI has used divs/anchors styled as buttons
  if (!submitted) {
    const rapidSelectors = [
      '[role="button"]:has-text("Sign Up")',
      '[role="button"]:has-text("Create")',
      '[role="button"]:has-text("Register")',
      '[role="button"]:has-text("Get Started")',
      'a:has-text("Sign Up")',
      'a:has-text("Create Account")',
      'a:has-text("Get Started")',
      'button:has-text("Sign Up Free")',
      'button:has-text("Try It Free")',
      // Last resort: any visible button that's not a social-auth button
      'form button',
    ];
    for (const sel of rapidSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.click({ timeout: 3000 });
          submitted = true;
          console.log(`  RapidAPI: clicked fallback submit: ${sel}`);
          break;
        }
      } catch { /* try next */ }
    }
  }

  if (!submitted) return { success: false, reason: 'Submit button not found' };

  await page.waitForTimeout(5000);
  await page.screenshot({ path: `/tmp/marie-signup-${site.id}-after.png` });

  const text = await page.evaluate(() => document.body.innerText);
  const hasError = /error|invalid|already (exists|registered|taken)|try again/i.test(text);
  if (hasError) {
    const m = text.match(/(error|invalid|already)[^\n]{0,100}/i);
    return { success: false, reason: m?.[0] || 'Error detected on page' };
  }

  // RapidAPI does not send a verification email — session is ready immediately
  console.log('  RapidAPI: signup complete (no email verification required)');
  return { success: true, needsVerification: false };
}

async function signUp(page, site, email, password) {
  const url = site.fields['URL'];
  const siteName = site.fields['Name'];

  console.log(`\n  Navigating to: ${url}`);

  // Site-specific flows
  if (siteName === 'Tavily')      return signUpTavily(page, site, email, password);
  if (siteName === 'Grok / xAI') return signUpXAI(page, site, email, password);
  if (siteName === 'OMDB')        return signUpOMDB(page, site, email);
  if (siteName === 'Groq')        return signUpGroq(page, site, email, password);
  if (siteName === 'Last FM')     return signUpLastFM(page, site, email, password);
  if (siteName === 'RapidAPI')    return signUpRapidAPI(page, site, email, password);

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

// ─── API Key Capture ──────────────────────────────────────────────────────────

/**
 * Saves an API key as a new Credential record in Airtable, linked to the login.
 */
async function saveAPIKeyToAirtable(siteName, apiKey, loginId) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would save API key for ${siteName}: ${apiKey}`);
    return;
  }
  try {
    await axios.post(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_CREDS}`,
      {
        fields: {
          fld2lJoFqSGAEK5tw: `${siteName} — API Key`,
          flddhlUwVQW6vrY55: loginId ? [loginId] : [],
          fldSNad5zoyLbpebm: 'API Key',
          fld4tDedZ5uGVy3gP: 'Active',
          fldGMbEDOCtLXqbLX: apiKey,
          fld5NI6ls6Qu16wnL: `Captured automatically by Marie on ${new Date().toISOString().split('T')[0]}`,
        },
      },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    console.log(`  ✅ API key saved for ${siteName}: ${apiKey.slice(0, 12)}...`);
  } catch (err) {
    console.warn(`  ⚠️ API key Airtable save failed for ${siteName}:`, err.response?.data?.error || err.message);
  }
}

// Re-login helper for sites that use email+password (no magic link)
async function tryRelogin(page, loginUrl, email, password) {
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    const emailEl = page.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"]').first();
    if (!await emailEl.isVisible().catch(() => false)) return false;
    await emailEl.fill(email);
    const pwEl = page.locator('input[type="password"]').first();
    if (await pwEl.isVisible().catch(() => false)) {
      await pwEl.fill(password);
    } else {
      // Identifier-first flow — click Continue then fill password
      await page.locator('button[type="submit"], button:has-text("Continue")').first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const pwEl2 = page.locator('input[type="password"]').first();
      if (await pwEl2.isVisible().catch(() => false)) await pwEl2.fill(password);
    }
    await page.locator('button[type="submit"]').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(5000);
    console.log(`    Re-login landed: ${page.url().slice(0, 80)}`);
    return true;
  } catch (e) {
    console.warn(`    Re-login failed: ${e.message}`);
    return false;
  }
}

async function captureOpenRouterKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → OpenRouter: navigating to API keys page...');
    await page.goto('https://openrouter.ai/keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // If redirected to login, try logging in with credentials
    if (page.url().includes('/auth') || page.url().includes('/login') || page.url().includes('/sign')) {
      console.log('    Not authenticated — attempting re-login...');
      await tryRelogin(page, 'https://openrouter.ai/sign-in', mailConfig?.email || '', SIGNUP_PASSWORD);
      await page.goto('https://openrouter.ai/keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    // Click "Create Key" button
    const createBtn = page.locator('button:has-text("Create Key"), button:has-text("New Key"), button:has-text("Add Key")').first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(2000);

      // Fill in key name if prompted
      const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="key" i]').first();
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('Marie Auto Key');
        const confirmBtn = page.locator('button:has-text("Create"), button[type="submit"]').first();
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    // Grab key value — OpenRouter shows it in a text input or code block
    const keyEl = page.locator('input[value^="sk-or-v1-"], code:has-text("sk-or-v1-"), [data-testid*="key"] input').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = await keyEl.inputValue().catch(() => keyEl.textContent());
      if (key && key.startsWith('sk-or-v1-')) {
        await saveAPIKeyToAirtable('OpenRouter', key.trim(), loginId);
        return;
      }
    }

    // Fallback: scan all text for the key pattern
    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/sk-or-v1-[A-Za-z0-9_-]{40,}/);
    if (match) {
      await saveAPIKeyToAirtable('OpenRouter', match[0].trim(), loginId);
    } else {
      console.warn('  ⚠️ OpenRouter: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ OpenRouter key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureDeepSeekKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → DeepSeek: navigating to API keys page...');
    await page.goto('https://platform.deepseek.com/api_keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    if (page.url().includes('/login') || page.url().includes('/sign')) {
      console.log('    Not authenticated — attempting re-login...');
      await tryRelogin(page, 'https://platform.deepseek.com/login', mailConfig?.email || '', SIGNUP_PASSWORD);
      await page.goto('https://platform.deepseek.com/api_keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    // Click "Create new API key" button
    const createBtn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Generate")').first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(2000);

      // Confirm in modal if needed
      const confirmBtn = page.locator('button:has-text("Confirm"), button:has-text("Create"), button[type="submit"]').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    // Grab key — DeepSeek shows full key once in a modal
    const keyEl = page.locator('input[value^="sk-"], code:has-text("sk-"), [class*="key"] input').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = (await keyEl.inputValue().catch(() => keyEl.textContent())).trim();
      if (key && key.startsWith('sk-')) {
        await saveAPIKeyToAirtable('DeepSeek', key, loginId);
        return;
      }
    }

    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/sk-[A-Za-z0-9]{32,}/);
    if (match) {
      await saveAPIKeyToAirtable('DeepSeek', match[0], loginId);
    } else {
      console.warn('  ⚠️ DeepSeek: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ DeepSeek key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureTavilyKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → Tavily: navigating to API keys page...');
    await page.goto('https://app.tavily.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    if (page.url().includes('/login') || page.url().includes('/sign') || page.url().includes('auth0')) {
      console.log('    Not authenticated — attempting re-login...');
      await tryRelogin(page, 'https://app.tavily.com/sign-in', mailConfig?.email || '', SIGNUP_PASSWORD);
      await page.goto('https://app.tavily.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    // Tavily shows the key on the home dashboard
    const keyEl = page.locator('input[value^="tvly-"], code:has-text("tvly-"), [class*="api-key"], [class*="apiKey"]').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = (await keyEl.inputValue().catch(() => keyEl.textContent())).trim();
      if (key && key.startsWith('tvly-')) {
        await saveAPIKeyToAirtable('Tavily', key, loginId);
        return;
      }
    }

    // Try clicking a "Copy" or "Show" button near the key
    const showBtn = page.locator('button:has-text("Show"), button:has-text("Reveal"), button:has-text("Copy")').first();
    if (await showBtn.isVisible().catch(() => false)) {
      await showBtn.click();
      await page.waitForTimeout(1000);
    }

    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/tvly-[A-Za-z0-9_-]{20,}/);
    if (match) {
      await saveAPIKeyToAirtable('Tavily', match[0], loginId);
    } else {
      console.warn('  ⚠️ Tavily: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ Tavily key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureXAIKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → xAI: navigating to API keys page...');
    await page.goto('https://console.x.ai/team/default/api-keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // If not authenticated, re-request a fresh magic link.
    // xAI may keep the URL at the keys page while showing an auth overlay.
    const currentUrl = page.url();
    const hasLoginFormXAI = await page.locator('input[type="email"], button:has-text("Login with email")').first().isVisible().catch(() => false);
    const hasKeyTableXAI  = await page.locator('table, [class*="key"], button:has-text("Create")').first().isVisible().catch(() => false);
    const isNotAuthedXAI  = !currentUrl.includes('console.x.ai') || hasLoginFormXAI || !hasKeyTableXAI;
    console.log(`  xAI: url=${currentUrl.slice(0, 60)} hasLoginForm=${hasLoginFormXAI} hasKeyTable=${hasKeyTableXAI}`);
    if (isNotAuthedXAI && mailConfig?.email) {
      console.log(`  xAI: not authenticated — requesting fresh magic link...`);
      await page.goto('https://console.x.ai/sign-in', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(8000);

      try {
        const loginEmailBtn = page.locator('button:has-text("Login with email")').first();
        if (await loginEmailBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await loginEmailBtn.click();
          await page.waitForTimeout(2000);
        }
      } catch {}

      const emailInput = page.locator('input[type="email"], input[name="email"]').first();
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill(mailConfig.email);
        await page.waitForTimeout(500);
        try { await page.locator('button[type="submit"]').first().click({ timeout: 5000 }); } catch {}
        await page.waitForTimeout(3000);
        const inboxServiceXAI = mailConfig.service || 'gmail';
        console.log(`  xAI: fresh magic link requested, polling ${inboxServiceXAI} inbox...`);

        const sinceTs = Math.floor(Date.now() / 1000);
        const newMsgs = inboxServiceXAI === 'flash'
          ? await pollFlashInboxSince(mailConfig.email, sinceTs - 5, 120000)
          : await pollGmailInbox(mailConfig.email, sinceTs - 5, 120000);
        for (const msg of newMsgs) {
          const inlineBody = msg.content || msg.body || msg.html || msg.text || '';
          const mid = msg.mid || msg.id || msg.messageId;

          // Skip messages already processed in Phase 2
          if (mid && mailConfig.seenMids?.has(mid)) {
            console.log(`  xAI: skipping already-processed message ${mid}`);
            continue;
          }

          const body = inlineBody || (mid ? await fetchGmailMessageBody(mid, mailConfig.email) : '');
          const subj = msg.subject || msg.textSubject || '';
          if (body && (subj.toLowerCase().includes('x.ai') || subj.toLowerCase().includes('xai') || body.toLowerCase().includes('x.ai'))) {
            const linkMatch = body.match(/https?:\/\/[^\s"'<>]+(?:magic|token|verify|accounts\.x\.ai)[^\s"'<>]*/i)
                           || body.match(/https?:\/\/[^\s"'<>]{60,}/);
            if (linkMatch) {
              const link = linkMatch[0].replace(/&amp;/g, '&');
              console.log(`  xAI: clicking fresh magic link: ${link.slice(0, 80)}...`);
              if (mid) mailConfig.seenMids.add(mid);
              await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForTimeout(8000);  // auth redirect chain needs time to complete
              console.log(`  xAI: after magic link redirect: ${page.url().slice(0, 80)}`);
              break;
            }
          }
        }
      }

      // Re-navigate to keys page
      await page.goto('https://console.x.ai/team/default/api-keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    // Click "Create API Key" button
    const createBtn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Generate")').first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(2000);

      // Fill name if prompted
      const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="key" i]').first();
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('Marie Auto Key');
        const confirmBtn = page.locator('button:has-text("Create"), button[type="submit"]').first();
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    // xAI shows key starting with "xai-"
    const keyEl = page.locator('input[value^="xai-"], code:has-text("xai-"), [class*="key"] input').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = (await keyEl.inputValue().catch(() => keyEl.textContent())).trim();
      if (key && key.startsWith('xai-')) {
        await saveAPIKeyToAirtable('Grok / xAI', key, loginId);
        return;
      }
    }

    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/xai-[A-Za-z0-9_-]{40,}/);
    if (match) {
      await saveAPIKeyToAirtable('Grok / xAI', match[0], loginId);
    } else {
      console.warn('  ⚠️ xAI: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ xAI key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureTMDBKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → TMDB: navigating to API settings...');
    await page.goto('https://www.themoviedb.org/settings/api', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    if (page.url().includes('/login') || page.url().includes('/sign')) {
      console.log('    Not authenticated — attempting re-login...');
      await tryRelogin(page, 'https://www.themoviedb.org/login', mailConfig?.email || '', SIGNUP_PASSWORD);
      await page.goto('https://www.themoviedb.org/settings/api', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);
    }

    // TMDB shows API key (v3 auth) and Read Access Token (v4)
    const keyEl = page.locator('input#api_key, [id*="api_key"], input[name="api_key"]').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = (await keyEl.inputValue()).trim();
      if (key && key.length === 32) {
        await saveAPIKeyToAirtable('TMDB', key, loginId);
        return;
      }
    }

    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/[a-f0-9]{32}/);
    if (match) {
      await saveAPIKeyToAirtable('TMDB', match[0], loginId);
    } else {
      console.warn('  ⚠️ TMDB: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ TMDB key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureRapidAPIKey(context, loginId) {
  const page = await context.newPage();
  try {
    console.log('  → RapidAPI: navigating to developer apps...');
    await page.goto('https://rapidapi.com/developer/apps', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // Click first app to see its key
    const appItem = page.locator('[class*="app-item"], [class*="application"]').first();
    if (await appItem.isVisible().catch(() => false)) {
      await appItem.click();
      await page.waitForTimeout(2000);
    }

    // Find the API key (RapidAPI shows it as a long alphanumeric string)
    const keyEl = page.locator('input[value^="rapid"], input[value*="api-key"], [class*="key"] input, [data-testid*="key"] input').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = (await keyEl.inputValue()).trim();
      if (key && key.length > 20) {
        await saveAPIKeyToAirtable('RapidAPI', key, loginId);
        return;
      }
    }

    // Try broader text scan for UUID-like or long alphanumeric key
    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/[a-f0-9]{32,}/);
    if (match) {
      await saveAPIKeyToAirtable('RapidAPI', match[0], loginId);
    } else {
      console.warn('  ⚠️ RapidAPI: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ RapidAPI key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureGroqKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → Groq: navigating to API keys page...');
    await page.goto('https://console.groq.com/keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // If not authenticated, re-request a fresh magic link.
    // Groq uses Clerk which may keep the URL at /keys while showing a login overlay —
    // so check for the *absence* of authenticated UI elements, not just the URL.
    const currentUrl = page.url();
    const hasLoginForm = await page.locator('input[type="email"]').isVisible().catch(() => false);
    const hasKeyTable  = await page.locator('table, [class*="key"], [data-testid*="key"]').first().isVisible().catch(() => false);
    const isNotAuthed  = !currentUrl.includes('console.groq.com') || hasLoginForm || !hasKeyTable;
    console.log(`  Groq: url=${currentUrl.slice(0, 60)} hasLoginForm=${hasLoginForm} hasKeyTable=${hasKeyTable}`);
    if (isNotAuthed && mailConfig?.email) {
      console.log(`  Groq: not authenticated — requesting fresh magic link...`);
      await page.goto('https://console.groq.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);

      // Click "Sign up" tab if visible (in case Clerk shows login by default)
      const signUpTab = page.locator('a:has-text("Sign up"), button:has-text("Sign up")').first();
      if (await signUpTab.isVisible().catch(() => false)) {
        await signUpTab.click();
        await page.waitForTimeout(2000);
      }

      const emailInput = page.locator('input[type="email"], input[name*="email" i]').first();
      if (await emailInput.isVisible().catch(() => false)) {
        await emailInput.fill(mailConfig.email);
        await page.waitForTimeout(500);
        await playwrightClickSubmit(page);
        await page.waitForTimeout(3000);
        const inboxService = mailConfig.service || 'gmail';
        console.log(`  Groq: fresh magic link requested, polling ${inboxService} inbox...`);

        const sinceTs = Math.floor(Date.now() / 1000);
        const newMsgs = inboxService === 'flash'
          ? await pollFlashInboxSince(mailConfig.email, sinceTs - 5, 120000)
          : await pollGmailInbox(mailConfig.email, sinceTs - 5, 120000);
        for (const msg of newMsgs) {
          // Fetch body — Gmail only gives metadata, Flash includes content inline
          const inlineBody = msg.content || msg.body || msg.html || msg.text || '';
          const mid = msg.mid || msg.id || msg.messageId;

          // Skip messages already processed in Phase 2 — their tokens are consumed
          if (mid && mailConfig.seenMids?.has(mid)) {
            console.log(`  Groq: skipping already-processed message ${mid}`);
            continue;
          }

          const body = inlineBody || (mid ? await fetchGmailMessageBody(mid, mailConfig.email) : '');
          const subj = msg.subject || msg.textSubject || '';
          if (body && (subj.toLowerCase().includes('groq') || body.toLowerCase().includes('groq') || body.toLowerCase().includes('stytch'))) {
            const linkMatch = body.match(/https?:\/\/stytch\.com\/v1\/magic_links\/[^\s"'<>]+/i)
                           || body.match(/https?:\/\/[^\s"'<>]+\/v1\/magic_links\/[^\s"'<>]+/i)
                           || body.match(/https?:\/\/[^\s"'<>]+(?:magic_link|magiclink)[^\s"'<>]*/i)
                           || body.match(/https?:\/\/[^\s"'<>]{60,}/);
            if (linkMatch) {
              const link = linkMatch[0].replace(/&amp;/g, '&');
              console.log(`  Groq: clicking fresh magic link: ${link.slice(0, 80)}...`);
              if (mid) mailConfig.seenMids.add(mid);
              await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await page.waitForTimeout(8000);  // auth redirect chain needs time to complete
              const landedUrl = page.url();
              console.log(`  Groq: after magic link redirect: ${landedUrl.slice(0, 80)}`);
              if (landedUrl.includes('error')) console.warn(`  ⚠️ Groq: magic link redirect failed`);
              break;
            }
          }
        }
      }

      // Re-navigate to keys page after re-auth attempt
      await page.goto('https://console.groq.com/keys', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // Click "Create API Key"
    const createBtn = page.locator('button:has-text("Create API Key"), button:has-text("New Key"), button:has-text("Generate")').first();
    if (await createBtn.isVisible().catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(2000);

      // Fill name if prompted
      const nameInput = page.locator('input[placeholder*="name" i], input[placeholder*="key" i]').first();
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('Marie Auto Key');
        const confirmBtn = page.locator('button:has-text("Submit"), button:has-text("Create"), button[type="submit"]').first();
        await confirmBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    // Groq keys start with gsk_
    const keyEl = page.locator('input[value^="gsk_"], code:has-text("gsk_"), [class*="key"] input').first();
    if (await keyEl.isVisible().catch(() => false)) {
      const key = (await keyEl.inputValue().catch(() => keyEl.textContent())).trim();
      if (key && key.startsWith('gsk_')) {
        await saveAPIKeyToAirtable('Groq', key, loginId);
        return;
      }
    }

    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/gsk_[A-Za-z0-9]{40,}/);
    if (match) {
      await saveAPIKeyToAirtable('Groq', match[0], loginId);
    } else {
      console.warn('  ⚠️ Groq: key not found on page');
    }
  } catch (err) {
    console.warn(`  ⚠️ Groq key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function captureLastFMKey(context, loginId, mailConfig) {
  const page = await context.newPage();
  try {
    console.log('  → Last FM: navigating to API account page...');
    await page.goto('https://www.last.fm/api/account/create', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Check we're on the API account page (not redirected to login)
    const currentUrl = page.url();
    if (!currentUrl.includes('/api/')) {
      console.warn(`  ⚠️ Last FM: redirected to ${currentUrl} — not authenticated, skipping key capture`);
      return;
    }

    // Fill application name
    const appNameInput = page.locator('input[name="app_name"], input[id*="name"]').first();
    if (await appNameInput.isVisible().catch(() => false)) {
      await appNameInput.fill('Rascals Inc');
      const descInput = page.locator('textarea[name*="desc"], textarea[id*="desc"]').first();
      if (await descInput.isVisible().catch(() => false)) {
        await descInput.fill('Internal music data integration');
      }
      // Screenshot to debug what submit element is present
      await page.screenshot({ path: '/tmp/lastfm-api-form.png' });
      // Try multiple submit patterns — Last FM API form may use button or input
      const submitSelectors = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Apply")',
        'button:has-text("Create")',
        'button:has-text("Submit")',
        'button:has-text("Save")',
        '.btn[type="submit"]',
        'form .btn',
      ];
      let clicked = false;
      for (const sel of submitSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.click({ timeout: 5000 });
            clicked = true;
            console.log(`  Last FM API form submitted via: ${sel}`);
            break;
          }
        } catch { /* try next */ }
      }
      if (!clicked) {
        // Last resort: submit the form directly via JS
        const submitted = await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) { form.submit(); return true; }
          return false;
        });
        if (!submitted) {
          console.warn('  ⚠️ Last FM: could not find submit button or form — check /tmp/lastfm-api-form.png');
          return;
        }
        console.log('  Last FM API form submitted via JS form.submit()');
        clicked = true;
      }
      await page.waitForTimeout(3000);
    } else {
      console.warn('  ⚠️ Last FM: API account form not found — session may not be authenticated');
      return;
    }

    // Key appears after creation
    const bodyText = await page.locator('body').innerText();
    const match = bodyText.match(/[a-f0-9]{32}/);
    if (match) {
      await saveAPIKeyToAirtable('Last FM', match[0], loginId);
    } else {
      console.warn('  ⚠️ Last FM: key not found — may need to register app manually at last.fm/api/account/create');
    }
  } catch (err) {
    console.warn(`  ⚠️ Last FM key capture failed: ${err.message}`);
  } finally {
    await page.close();
  }
}

/**
 * Dispatcher: routes to the right capture function based on site name.
 * Returns without error for sites that don't have API keys to capture.
 */
async function captureAPIKey(context, siteName, loginId, mailConfig) {
  const name = (siteName || '').toLowerCase();
  if (name.includes('openrouter'))    return captureOpenRouterKey(context, loginId, mailConfig);
  if (name.includes('deepseek'))      return captureDeepSeekKey(context, loginId, mailConfig);
  if (name.includes('tavily'))        return captureTavilyKey(context, loginId, mailConfig);
  if (name === 'groq')                return captureGroqKey(context, loginId, mailConfig);
  if (name.includes('xai') || (name.includes('grok') && !name.includes('groq'))) return captureXAIKey(context, loginId, mailConfig);
  if (name.includes('tmdb'))          return captureTMDBKey(context, loginId, mailConfig);
  if (name.includes('rapidapi'))      return captureRapidAPIKey(context, loginId);
  if (name.includes('last fm') || name.includes('lastfm')) return captureLastFMKey(context, loginId, mailConfig);
  // MusicBrainz, Socialcrawl, Qwen: no automated key capture — skip silently
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

  // Get ONE email address for the entire batch (Gmail preferred, Flash fallback)
  const startTimestamp = Math.floor(Date.now() / 1000); // Unix ts — Gmail inbox filter
  const { email: batchEmail, service: emailService } = await getBatchEmail();
  console.log(`\nBatch email for this run: ${batchEmail} (via ${emailService})`);

  // Persistent mail config — seenMids tracks message IDs processed in Phase 2
  // so Phase 4 re-auth never re-clicks an already-consumed magic link
  const mailConfig = { email: batchEmail, service: emailService, seenMids: new Set() };

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
          isRepeatable: !!site.fields['Repeatable'],
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

  // ── Phase 2: Gmail inbox poll — click ALL verification links ────────────
  const needVerify = submitted.filter(s => s.needsVerification || s.isOMDB);
  if (needVerify.length > 0) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Phase 2 — Polling ${emailService} inbox for ${needVerify.length} account verification(s)`);
    console.log('═'.repeat(60));

    // Poll the batch inbox — Flash returns full HTML bodies, Gmail needs per-message fetch
    const messages = await pollBatchInbox(batchEmail, emailService, startTimestamp, 600000);
    console.log(`  Found ${messages.length} message(s) in inbox`);

    const omdbItem = submitted.find(s => s.isOMDB);

    for (const msg of messages) {
      // Normalise field names — Gmail uses textSubject/textFrom, Flash may differ
      const subject = msg.textSubject || msg.subject  || msg.Subject || msg.mail_subject || '(no subject)';
      const from    = msg.textFrom    || msg.from     || msg.From    || msg.sender       || msg.mail_from || '';
      const mid     = msg.mid         || msg.id       || msg.messageId;
      // Flash returns body inline; Gmail requires a separate /message fetch
      const inlineBody = msg.body || msg.textBody || msg.htmlBody || msg.html || msg.text || msg.content || '';

      console.log(`\n  Message: "${subject}" from ${from}`);

      // Track this mid so Phase 4 re-auth never re-clicks a consumed magic link
      if (mid) mailConfig.seenMids.add(mid);

      // Get full body — use inline if present (Flash), else fetch via API (Gmail)
      const body = inlineBody || (mid ? await fetchGmailMessageBody(mid, batchEmail) : '');
      if (!body) console.warn('  ⚠️ No body found for this message');

      // OMDB sends API key in email body (not a verification link)
      if (omdbItem && (from.toLowerCase().includes('omdb') || subject.toLowerCase().includes('omdb'))) {
        const keyMatch = body.match(/\b([a-f0-9]{8})\b/i);
        if (keyMatch) {
          console.log(`  OMDB API key: ${keyMatch[1]}`);
          await saveOMDBApiKey(batchEmail, keyMatch[1]);
          omdbItem.omdbDone = true;
        }
        continue;
      }

      // RapidAPI verification emails are a special case: the email contains
      // multiple SendGrid /ls/click tracker URLs (header logo, Verify Email
      // CTA, footer link). Picking the wrong one redirects to the public
      // homepage and the account is never verified, even though landedUrl
      // doesn't contain "error". So: parse anchor tags and prefer the one
      // whose visible text says Verify/Confirm. After clicking, probe
      // /developer/dashboard — if it bounces to /auth/, the session isn't
      // really authenticated.
      const isRapidAPIEmail = /rapidapi\.com|nokia\s+api/i.test(from + ' ' + subject);
      let link = null;

      if (isRapidAPIEmail) {
        const anchors = [...body.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        const candidates = anchors
          .map(m => ({ href: m[1].replace(/&amp;/g, '&'), text: m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }))
          .filter(a => /^https?:\/\/(?:[a-z0-9.-]*\.)?rapidapi\.com\//i.test(a.href));
        const verifyAnchor = candidates.find(a => /verify|confirm|activate/i.test(a.text))
                          || candidates.find(a => /(?:confirm|verify|magic|activate)/i.test(a.href));
        if (verifyAnchor) link = verifyAnchor.href;
      }

      if (!link) {
        const linkMatch =
          body.match(/https?:\/\/[^\s"'<>]+(?:verif|confirm|activate|validate|magic|token)[^\s"'<>]*/i) ||
          body.match(/https?:\/\/[^\s"'<>]{50,}/);
        if (linkMatch) link = linkMatch[0].replace(/&amp;/g, '&');
      }

      if (link) {
        console.log(`  Clicking: ${link.slice(0, 100)}...`);

        // For Stytch magic links (Groq/xAI), navigate in a fresh page but first
        // briefly visit the service domain so session cookies are in scope
        const isStytch = link.includes('stytch.com/v1/magic_links');
        const verifyPage = await context.newPage();
        try {
          if (isStytch) {
            // Prime the Groq domain cookies before following the Stytch redirect
            await verifyPage.goto('https://console.groq.com/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await verifyPage.waitForTimeout(1000);
          }
          // Use domcontentloaded — Stytch/magic links never reach networkidle (continuous polling)
          await verifyPage.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 });
          // Wait 8s for auth redirect chain to complete and set session cookies in context
          await verifyPage.waitForTimeout(8000);
          const landedUrl = verifyPage.url();
          console.log(`  Landed: ${landedUrl.slice(0, 80)}`);
          try { await verifyPage.screenshot({ path: `/tmp/marie-verify-${Date.now()}.png` }); } catch {}

          let verified = !(landedUrl.includes('error') || landedUrl.includes('redirect-error'));
          // For RapidAPI: probe /developer/dashboard — public homepage isn't
          // logged in even though it doesn't contain "error".
          if (verified && isRapidAPIEmail) {
            await verifyPage.goto('https://rapidapi.com/developer/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await verifyPage.waitForTimeout(3000);
            const dashUrl = verifyPage.url();
            if (/\/auth\/(?:login|sign-in|sign-up)/i.test(dashUrl)) {
              verified = false;
              console.warn(`  ⚠️ RapidAPI magic link did NOT authenticate — dashboard bounced to ${dashUrl}`);
            } else if (dashUrl.includes('/developer/')) {
              console.log(`  Dashboard reachable: ${dashUrl.slice(0, 80)}`);
            }
          }

          if (verified) {
            console.log(`  ✅ Verified (${landedUrl.slice(0, 80)})`);
          } else if (!isRapidAPIEmail) {
            console.warn(`  ⚠️ Verification failed — landed on error page: ${landedUrl.slice(0, 80)}`);
          }
        } catch (err) {
          console.warn(`  Verification nav failed: ${err.message}`);
        }
        await verifyPage.close();
      } else {
        console.log(`  No verification link found in this message`);
      }
    }

    if (messages.length === 0) {
      console.warn('  ⚠️ Gmail inbox empty after timeout — check API key and email delivery');
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
    let isLoggedIn = false;
    try {
      await rapidPage.goto('https://rapidapi.com/hub', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await rapidPage.waitForTimeout(3000);
      // Use URL as primary signal — if we land anywhere other than /auth/login, session is active
      const rapidUrl = rapidPage.url();
      isLoggedIn = !rapidUrl.includes('/auth/login');
      console.log(`  RapidAPI session active: ${isLoggedIn} (URL: ${rapidUrl})`);
    } catch (e) {
      console.warn(`  RapidAPI session check failed: ${e.message}`);
    }
    await rapidPage.close();

    // Store session result on rapidItem so Phase 4 knows whether to trust these credentials
    rapidItem.sessionVerified = isLoggedIn;

    if (!isLoggedIn) {
      console.log('  ⚠️ RapidAPI not authenticated — skipping subscriptions. Credentials will be saved as Unverified.');
    } else {
      const subResults = await subscribeToRapidAPIs(context);
      rapidItem.subResults = subResults;
    }
  }

  // ── Phase 4: Save credentials + mark Done ────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Phase 4 — Saving credentials');
  console.log('═'.repeat(60));

  for (const item of submitted) {
    const siteName = item.site.fields['Name'];
    const notes    = item.site.fields['Notes'] || '';

    try {
      let loginId = null;
      if (!item.isOMDB) {
        // RapidAPI: save as 'Unverified' if the browser session wasn't confirmed active in Phase 3.
        // The subscriber script will upgrade to 'Active' after a successful fresh login.
        const loginStatus = (item.isRapidAPI && !item.sessionVerified) ? 'Unverified' : 'Active';
        if (item.isRapidAPI && !item.sessionVerified) {
          console.log(`  ⚠️ RapidAPI session was not verified — saving as Unverified (credentials may not work)`);
        }
        loginId = await saveToAirtable(siteName, batchEmail, SIGNUP_PASSWORD, notes, loginStatus);
      }

      // Attempt to capture API key from the site dashboard
      if (loginId) {
        try {
          await captureAPIKey(context, siteName, loginId, mailConfig);
        } catch (keyErr) {
          console.warn(`  ⚠️ API key capture failed for ${siteName}: ${keyErr.message}`);
        }
      }

      // If this is the RapidAPI login, link it back to all APIs we subscribed to in Phase 3
      if (item.isRapidAPI && loginId && item.subResults?.subscribed?.length) {
        const subscribedIds = item.subResults.subscribed.map(s => s.recordId);
        console.log(`  → Linking RapidAPI login to ${subscribedIds.length} subscribed API(s)...`);
        await linkLoginToSubscribedAPIs(subscribedIds, loginId);
      }

      // Repeatable sites (e.g. RapidAPI) reset to Pending so each run creates a fresh account
      const nextStatus = item.isRepeatable ? 'Pending' : 'Done';
      await updateSignupStatus(item.site.id, nextStatus, {
        'Email Used': batchEmail,
        'Completed At': new Date().toISOString(),
      });
      if (item.isRepeatable) console.log(`  ↻ ${siteName} is Repeatable — reset to Pending for next run`);

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
  const lines = [`🔐 *Marie — Account Creator Summary*`, `_Batch Gmail: ${batchEmail}_`];
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
