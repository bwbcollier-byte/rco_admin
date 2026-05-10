/**
 * Marie — RapidAPI Subscriber & Enricher
 *
 * 1. Reads ALL active RapidAPI logins from Airtable Logins
 * 2. For each account:
 *    - Logs into RapidAPI with those credentials
 *    - For every API in the APIs table where {Subscribe via Kondo} is checked:
 *      - Subscribes to the free / basic plan (if not already subscribed)
 *      - On the first account: scrapes About, Category, Provider, endpoints, MCP URL
 *      - Updates the Airtable APIs record with everything gathered
 *      - Appends the RapidAPI Login record to "Subscribed Accounts" (never replaces)
 *
 * Airtable APIs table — new fields to add before running:
 *   About          (Long text)
 *   Category       (Single line text)
 *   Provider       (Single line text)
 *   Endpoints      (Long text — stores JSON array)
 *   MCP URL        (URL)
 *   Pricing Tier   (Single line text)
 *
 * Secrets required (same as marie-signup):
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING  (optional — for summary)
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_LOGINS  = process.env.AIRTABLE_LOGINS;
const AIRTABLE_APIS    = process.env.AIRTABLE_APIS;

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL    = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN          = process.env.DRY_RUN === 'true';

// Logins table field IDs — set via GitHub repo variables
const LOGIN_FIELD = {
  siteName: process.env.FIELD_LOGIN_SITE_NAME,
  email:    process.env.FIELD_LOGIN_EMAIL,
  password: process.env.FIELD_LOGIN_PASSWORD,
  status:   process.env.FIELD_LOGIN_STATUS,
};

// APIs table field IDs — set via GitHub repo variables
const API_FIELD = {
  subscribed:         process.env.FIELD_API_SUBSCRIBED,
  subscribedAccounts: 'Subscribed Accounts',  // Linked records (use name)
};

// ─── Airtable ─────────────────────────────────────────────────────────────────

async function getAllRapidAPILogins() {
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LOGINS}`,
    {
      params: { returnFieldsByFieldId: true, maxRecords: 100 },
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    }
  );
  const all = (res.data.records || [])
    .filter(r => r.fields[LOGIN_FIELD.siteName] === 'RapidAPI')
    .sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime)); // oldest first

  // Only process accounts that are Active or Unverified (skip Failed/Inactive)
  const records = all.filter(r => {
    const status = r.fields[LOGIN_FIELD.status];
    return !status || status === 'Active' || status === 'Unverified';
  });

  if (!records.length) throw new Error('No active RapidAPI logins found in Airtable Logins table');
  const unverified = records.filter(r => r.fields[LOGIN_FIELD.status] === 'Unverified').length;
  console.log(`  Found ${records.length} RapidAPI account(s) to try (${unverified} unverified)`);
  return records.map(r => ({
    email:    r.fields[LOGIN_FIELD.email],
    password: r.fields[LOGIN_FIELD.password],
    loginId:  r.id,
    status:   r.fields[LOGIN_FIELD.status] || 'Active',
  }));
}

async function updateLoginStatus(loginId, status) {
  if (DRY_RUN) return;
  try {
    await axios.patch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LOGINS}/${loginId}`,
      { fields: { [LOGIN_FIELD.status]: status } },
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' } }
    );
  } catch {}
}

async function getAPIsToProcess() {
  const res = await axios.get(
    `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}`,
    {
      params: {
        filterByFormula: `{Subscribe via Kondo}`,
        fields: ['Name', 'Link', 'Subscribed', 'Subscribe via Kondo', 'About'],
      },
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    }
  );
  return res.data.records || [];
}

async function updateAPIRecord(recordId, data, loginId) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update API record ${recordId}:`, Object.keys(data).join(', '), loginId ? `+ link loginId ${loginId}` : '');
    return;
  }

  const headers = { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}/${recordId}`;

  // ── Step 1: Always mark Subscribed (core — must succeed) ──────────────────
  await axios.patch(url, { fields: { [API_FIELD.subscribed]: true } }, { headers });

  // ── Step 2: Append loginId to Subscribed Accounts (best-effort) ───────────
  if (loginId) {
    try {
      const current = await axios.get(url, { headers });
      const existingLinks = current.data.fields?.[API_FIELD.subscribedAccounts] || [];
      if (!existingLinks.includes(loginId)) {
        await axios.patch(
          url,
          { fields: { [API_FIELD.subscribedAccounts]: [...existingLinks, loginId] } },
          { headers }
        );
      }
    } catch (e) {
      console.warn(`  ⚠️ Could not update Subscribed Accounts link: ${e.response?.status || e.message} (field may not exist yet)`);
    }
  }

  // ── Step 3: Write enrichment fields one-by-one (best-effort, skip missing) ─
  for (const [fieldName, value] of Object.entries(data)) {
    if (!value && value !== false) continue;  // skip empty/null
    try {
      await axios.patch(url, { fields: { [fieldName]: value } }, { headers });
    } catch (e) {
      if (e.response?.status === 422) {
        console.warn(`  ⚠️ Field "${fieldName}" not found in Airtable — skipping (add it to the APIs table)`);
      } else {
        throw e;
      }
    }
  }
}

// ─── RapidAPI Login ───────────────────────────────────────────────────────────

async function loginToRapidAPI(page, email, password) {
  console.log(`\n  Logging in to RapidAPI as ${email}...`);
  await page.goto('https://rapidapi.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Wait for and dismiss cookie consent banner
  try {
    await page.locator('button:has-text("Reject All"), button:has-text("Accept All")').first().waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('button:has-text("Reject All")').first().click();
    console.log('  Dismissed cookie banner');
    await page.waitForTimeout(1500);
  } catch {
    console.log('  No cookie banner (or already dismissed)');
  }

  // Wait for email field to be visible
  const emailInput = page.locator('input[name="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 10000 });

  // Use pressSequentially to simulate real typing (React-friendly)
  await emailInput.click();
  await emailInput.pressSequentially(email, { delay: 60 });
  await page.waitForTimeout(400);

  // Password
  const passInput = page.locator('input[type="password"]').first();
  if (!await passInput.isVisible().catch(() => false)) {
    throw new Error('RapidAPI login: password field not found');
  }
  await passInput.click();
  await passInput.pressSequentially(password, { delay: 60 });
  await page.waitForTimeout(400);

  // Submit
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(8000);

  // Verify login — success = URL moved away from /auth/login
  const finalUrl = page.url();
  if (finalUrl.includes('/auth/login')) {
    await page.screenshot({ path: '/tmp/rapidapi-login-failed.png' }).catch(() => {});
    throw new Error(`RapidAPI login failed — landed on: ${finalUrl}`);
  }
  console.log(`  ✅ Logged in to RapidAPI (${finalUrl})`);
}

// ─── Subscribe ────────────────────────────────────────────────────────────────

async function subscribeToAPI(page, link, name) {
  const pricingUrl = link.includes('/pricing') ? link : link.replace(/\/?$/, '') + '/pricing';
  console.log(`  → Subscribing: ${pricingUrl}`);
  await page.goto(pricingUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });

  // Wait for plan cards to render (React SPA — buttons appear after JS hydration)
  try {
    await page.waitForSelector(
      'button:has-text("Start Free Plan"), button:has-text("Current Plan"), ' +
      'button:has-text("Choose This Plan"), button:has-text("Manage My Plan"), ' +
      'button:has-text("Subscribe")',
      { timeout: 12000 }
    );
  } catch {
    // Selector timeout — page may have an unusual layout; proceed anyway
    await page.waitForTimeout(3000);
  }

  // Check if already subscribed — RapidAPI shows "Current Plan" button on the active tier
  const alreadySub = await page.locator(
    '[class*="CurrentPlan"], [class*="current-plan"], [class*="currentPlan"], ' +
    'button:has-text("Current Plan"), span:has-text("Current Plan"), ' +
    'button:has-text("Manage My Plan"), button:has-text("Manage Plan"), ' +
    '[class*="active"][class*="plan"], [class*="plan"][class*="selected"], ' +
    'text=/current plan|already subscribed|you.re subscribed|manage my plan|manage plan/i'
  ).first().isVisible().catch(() => false);
  if (alreadySub) {
    console.log(`  ✅ Already subscribed to ${name}`);
    return true;
  }

  // RapidAPI plan cards — find the Basic/Free plan and click its Subscribe button.
  // Actual button text observed on RapidAPI pricing pages (2025):
  //   Free tier  → "Start Free Plan"
  //   Paid tiers → "Choose This Plan"
  //   Already subscribed → "Current Plan" (handled above)
  const planCardSelectors = [
    // Most specific — free plan button (what we always want)
    'button:has-text("Start Free Plan")',
    'a:has-text("Start Free Plan")',
    // Fallbacks in case text varies
    'button:has-text("Subscribe to Test")',
    'button:has-text("Subscribe")',
    'button:has-text("Select Plan")',
    'button:has-text("Start Free Trial")',
    'button:has-text("Get Started")',
    'a:has-text("Subscribe")',
    // Last resort: first "Choose This Plan" button (lowest tier)
    'button:has-text("Choose This Plan")',
  ];

  let clicked = false;
  for (const sel of planCardSelectors) {
    try {
      // Use first() — if there are multiple plan tiers the first is typically the free one
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        const btnText = (await btn.textContent().catch(() => '')).trim();
        console.log(`    Clicking: "${btnText}" (selector: ${sel.slice(0, 60)})`);
        await btn.click();
        await page.waitForTimeout(3000);
        clicked = true;
        break;
      }
    } catch {}
  }

  if (clicked) {
    // Confirm modal if it appears
    try {
      await page.locator('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Subscribe")').first().click({ timeout: 4000 });
      await page.waitForTimeout(2000);
    } catch {}
    console.log(`  ✅ Subscribed to ${name}`);
    return true;
  }

  // Still not found — log all visible button texts to understand what RapidAPI is showing
  const visibleBtns = await page.evaluate(() =>
    [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(t => t)
  ).catch(() => []);
  console.warn(`  ⚠️ Could not find subscribe button for ${name}`);
  if (visibleBtns.length) console.warn(`    Visible buttons: ${visibleBtns.slice(0, 10).join(' | ')}`);

  const screenshotPath = `/tmp/rapidapi-sub-fail-${Date.now()}.png`;
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  return false;
}

// ─── Scrape API Overview ──────────────────────────────────────────────────────

async function scrapeAPIOverview(page, link) {
  // Navigate to the main API page (not pricing)
  const baseUrl = link.replace(/\/pricing\/?$/, '').replace(/\/$/, '');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(4000);

  const overview = { about: '', category: '', provider: '', pricingTier: '', mcpUrl: '' };

  // Provider — usually in the URL: rapidapi.com/{provider}/{api}
  try {
    const urlParts = new URL(baseUrl).pathname.split('/').filter(Boolean);
    if (urlParts.length >= 2) overview.provider = urlParts[0];
  } catch {}

  // About / description — try multiple selector strategies
  for (const sel of [
    '[class*="DescriptionBox"], [class*="description-box"]',
    '[class*="apiAbout"], [class*="api-about"]',
    'section[class*="about"]',
    '[data-testid*="description"]',
    'p[class*="description"]',
    'div[class*="overview"] p',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const text = (await el.textContent()).trim();
        if (text.length > 20) { overview.about = text.slice(0, 3000); break; }
      }
    } catch {}
  }

  // Category
  for (const sel of [
    '[class*="category"], [data-testid*="category"]',
    'a[href*="/category/"]',
    '[class*="tag"]:first-child',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const text = (await el.textContent()).trim();
        if (text) { overview.category = text; break; }
      }
    } catch {}
  }

  // Pricing tier on the free plan
  for (const sel of [
    '[class*="free"][class*="plan"], [class*="basic"][class*="plan"]',
    'div:has-text("Free") [class*="limit"], div:has-text("Basic") [class*="limit"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const text = (await el.textContent()).trim();
        if (text) { overview.pricingTier = text.slice(0, 200); break; }
      }
    } catch {}
  }

  // MCP — look for MCP tab, link, or section
  for (const sel of [
    'a:has-text("MCP"), button:has-text("MCP")',
    '[href*="mcp"], [href*="/mcp"]',
    '[class*="mcp"], [data-testid*="mcp"]',
  ]) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const href = await el.getAttribute('href').catch(() => '');
        overview.mcpUrl = href
          ? (href.startsWith('http') ? href : `https://rapidapi.com${href}`)
          : `${baseUrl}/mcp`;
        break;
      }
    } catch {}
  }
  // Also construct a likely MCP URL even if not found on page
  if (!overview.mcpUrl) {
    overview.mcpUrl = `${baseUrl}/mcp`;
  }

  return overview;
}

// ─── Scrape Endpoints ─────────────────────────────────────────────────────────

async function scrapeEndpoints(page) {
  const endpoints = [];

  // Wait for sidebar to load
  await page.waitForTimeout(2000);

  // RapidAPI sidebar endpoint items — try multiple selector strategies
  const endpointSelectors = [
    '[class*="EndpointListItem"], [class*="endpoint-list-item"]',
    '[data-testid*="endpoint-item"]',
    'li[class*="endpoint"]',
    '[class*="SidebarItem"][class*="endpoint"]',
    'ul[class*="endpoints"] li',
    '[class*="method-"] + [class*="path"]',  // method badge next to path
  ];

  let found = false;
  for (const sel of endpointSelectors) {
    try {
      const items = await page.locator(sel).all();
      if (items.length > 0) {
        console.log(`    Found ${items.length} endpoint item(s) with selector: ${sel}`);
        for (const item of items.slice(0, 30)) {
          try {
            const text = (await item.textContent()).trim();
            // Parse method + path from text (e.g. "GET /users/{id}")
            const methodMatch = text.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i);
            const method = methodMatch ? methodMatch[1].toUpperCase() : '';
            const rest = method ? text.slice(method.length).trim() : text;
            endpoints.push({ method, path: rest.split('\n')[0].trim(), description: '' });
          } catch {}
        }
        found = true;
        break;
      }
    } catch {}
  }

  if (!found) {
    // Fallback: scan page text for endpoint patterns
    try {
      const bodyText = await page.locator('body').innerText();
      const lines = bodyText.split('\n');
      for (const line of lines) {
        const m = line.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s]{3,})/i);
        if (m) {
          endpoints.push({ method: m[1].toUpperCase(), path: m[2], description: '' });
        }
      }
    } catch {}
  }

  // Deduplicate by method+path
  const seen = new Set();
  return endpoints.filter(e => {
    const key = `${e.method}:${e.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Scrape Curl + Response for an Endpoint ───────────────────────────────────

async function scrapeEndpointDetail(page, endpointItem) {
  // Click the endpoint in the sidebar
  const detail = { curl: '', response: '' };

  try {
    // Try clicking the endpoint by its path text
    const itemLocator = page.locator(
      `text="${endpointItem.path}", [class*="endpoint"]:has-text("${endpointItem.path}")`
    ).first();
    if (await itemLocator.isVisible({ timeout: 3000 }).catch(() => false)) {
      await itemLocator.click();
      await page.waitForTimeout(2000);
    }
  } catch {}

  // Get curl from "Shell" / "cURL" code snippet tab
  for (const tabSel of [
    'button:has-text("Shell"), button:has-text("cURL"), button:has-text("Curl")',
    '[role="tab"]:has-text("Shell"), [role="tab"]:has-text("curl")',
  ]) {
    try {
      const tab = page.locator(tabSel).first();
      if (await tab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await tab.click();
        await page.waitForTimeout(1000);
        break;
      }
    } catch {}
  }

  // Extract curl command
  for (const codeSel of [
    'pre:has-text("curl"), code:has-text("curl")',
    '[class*="code-snippet"] pre',
    '[class*="CodeSnippet"] pre',
    '[class*="codeBlock"] pre',
  ]) {
    try {
      const el = page.locator(codeSel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        const text = (await el.textContent()).trim();
        if (text.includes('curl') || text.includes('--url')) {
          detail.curl = text.slice(0, 2000);
          break;
        }
      }
    } catch {}
  }

  // Get example response
  for (const resSel of [
    '[class*="response-example"] pre',
    '[class*="ResponseExample"] pre',
    '[class*="result"] pre',
    '[class*="response"] code',
  ]) {
    try {
      const el = page.locator(resSel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        detail.response = (await el.textContent()).trim().slice(0, 2000);
        break;
      }
    } catch {}
  }

  return detail;
}

// ─── Process one API ──────────────────────────────────────────────────────────

// doScrape = true on the first account pass; false for subsequent accounts (subscribe-only)
async function processAPI(context, apiRecord, loginId, doScrape = true) {
  const name = apiRecord.fields['Name'] || apiRecord.id;
  const link = apiRecord.fields['Link'];

  if (!link) {
    console.warn(`  ⚠️ ${name}: no Link field — skipping`);
    return { name, status: 'skip', reason: 'No Link' };
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`API: ${name}  |  ${link}${doScrape ? '' : '  (subscribe-only)'}`);

  const page = await context.newPage();
  const result = { name, status: 'ok', fieldsUpdated: [] };

  try {
    // 1. Subscribe
    const subscribed = await subscribeToAPI(page, link, name);
    if (!subscribed) {
      result.status = 'warn';
      result.reason = 'Subscribe button not found';
    }

    const updateFields = {};

    if (doScrape) {
      // 2. Scrape overview
      const overview = await scrapeAPIOverview(page, link);
      console.log(`  About: ${overview.about.slice(0, 80) || '(none found)'}...`);
      console.log(`  Category: ${overview.category || '(none)'}, Provider: ${overview.provider || '(none)'}`);
      console.log(`  MCP URL: ${overview.mcpUrl}`);

      // 3. Scrape endpoints
      const endpoints = await scrapeEndpoints(page);
      console.log(`  Endpoints found: ${endpoints.length}`);

      // 4. For first 10 endpoints, get curl + response detail
      const enrichedEndpoints = [];
      for (const ep of endpoints.slice(0, 10)) {
        const detail = await scrapeEndpointDetail(page, ep);
        enrichedEndpoints.push({ ...ep, ...detail });
        if (detail.curl) console.log(`    ${ep.method} ${ep.path} — curl captured`);
      }
      for (const ep of endpoints.slice(10)) enrichedEndpoints.push(ep);

      // 5. Build Airtable payload
      if (overview.about)       { updateFields['About']        = overview.about;       result.fieldsUpdated.push('About'); }
      if (overview.category)    { updateFields['Category']     = overview.category;    result.fieldsUpdated.push('Category'); }
      if (overview.provider)    { updateFields['Provider']     = overview.provider;    result.fieldsUpdated.push('Provider'); }
      if (overview.mcpUrl)      { updateFields['MCP URL']      = overview.mcpUrl;      result.fieldsUpdated.push('MCP URL'); }
      if (overview.pricingTier) { updateFields['Pricing Tier'] = overview.pricingTier; result.fieldsUpdated.push('Pricing Tier'); }
      if (enrichedEndpoints.length > 0) {
        updateFields['Endpoints'] = JSON.stringify(enrichedEndpoints, null, 2).slice(0, 99000);
        result.fieldsUpdated.push(`Endpoints (${enrichedEndpoints.length})`);
      }
    }

    // 6. Update Airtable (always — marks subscribed + appends to Subscribed Accounts)
    await updateAPIRecord(apiRecord.id, updateFields, loginId);
    console.log(`  ✅ Airtable updated: ${result.fieldsUpdated.join(', ') || 'Subscribed + linked account'}`);

  } catch (err) {
    console.warn(`  ❌ ${name}: ${err.message}`);
    result.status = 'error';
    result.reason = err.message;
  } finally {
    await page.close();
  }

  return result;
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postToSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) return;
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: SLACK_CHANNEL, text,
    }, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    });
  } catch {}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('Marie — RapidAPI Subscriber & Enricher');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  if (!AIRTABLE_API_KEY) throw new Error('AIRTABLE_API_KEY not set');

  // 1. Get ALL RapidAPI accounts
  console.log('\nFetching RapidAPI accounts from Airtable...');
  const allLogins = await getAllRapidAPILogins();

  // 2. Get APIs to process
  const apis = await getAPIsToProcess();
  console.log(`\nAPIs to process: ${apis.length} (Subscribe via Kondo = checked)`);
  if (apis.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const allAccountResults = [];

  // 3. Loop over every RapidAPI account
  for (let i = 0; i < allLogins.length; i++) {
    const credentials = allLogins[i];
    const isFirst = i === 0;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Account ${i + 1} / ${allLogins.length}: ${credentials.email}`);
    console.log(isFirst ? '  (will subscribe + scrape/enrich)' : '  (will subscribe-only + link account)');
    console.log('='.repeat(60));

    // Launch a fresh browser for each account (clean session)
    const browser = await chromium.launch({
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-AU',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    let accountOk = true;
    const results = { ok: [], warn: [], error: [], skip: [] };

    // Log in
    const loginPage = await context.newPage();
    try {
      await loginToRapidAPI(loginPage, credentials.email, credentials.password);
      // Login succeeded — if this account was Unverified, promote it to Active
      if (credentials.status === 'Unverified') {
        await updateLoginStatus(credentials.loginId, 'Active');
        console.log(`  ✅ Promoted ${credentials.email} from Unverified → Active`);
      }
    } catch (loginErr) {
      console.error(`  ❌ Login failed for ${credentials.email}: ${loginErr.message}`);
      await loginPage.screenshot({ path: `/tmp/rapidapi-login-fail-${i}.png` }).catch(() => {});
      // Mark failed accounts so we don't keep retrying them
      await updateLoginStatus(credentials.loginId, 'Failed');
      accountOk = false;
    } finally {
      await loginPage.close();
    }

    if (accountOk) {
      // Process each API for this account
      for (const api of apis) {
        // First account gets full scrape; subsequent accounts subscribe-only
        const doScrape = isFirst;
        const result = await processAPI(context, api, credentials.loginId, doScrape);
        (results[result.status] || results.error).push(result);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    await browser.close();

    allAccountResults.push({ email: credentials.email, results, accountOk });

    // Brief pause between accounts
    if (i < allLogins.length - 1) {
      console.log('\n  Pausing 5s before next account...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // 4. Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary — All Accounts');
  console.log('='.repeat(60));

  const slackLines = [`🔌 *Marie — RapidAPI Subscriber & Enricher*`];

  for (const { email, results, accountOk } of allAccountResults) {
    console.log(`\nAccount: ${email}${accountOk ? '' : ' ❌ LOGIN FAILED'}`);
    if (!accountOk) {
      slackLines.push(`\n❌ *${email}* — login failed`);
      continue;
    }
    console.log(`  ✅ ${results.ok.length}  ⚠️  ${results.warn.length}  ❌ ${results.error.length}  ⏭ ${results.skip.length}`);
    if (results.warn.length)  results.warn.forEach(r  => console.log(`  ⚠️  ${r.name}: ${r.reason}`));
    if (results.error.length) results.error.forEach(r => console.log(`  ❌ ${r.name}: ${r.reason}`));

    const total = results.ok.length + results.warn.length + results.error.length;
    slackLines.push(`\n*${email}* — ${results.ok.length}/${total} ok`);
    if (results.ok.length) {
      results.ok.slice(0, 10).forEach(r => slackLines.push(`  • ${r.name}${r.fieldsUpdated?.length ? ' — ' + r.fieldsUpdated.join(', ') : ''}`));
      if (results.ok.length > 10) slackLines.push(`  • …and ${results.ok.length - 10} more`);
    }
    if (results.error.length) {
      results.error.forEach(r => slackLines.push(`  ❌ ${r.name}: ${r.reason}`));
    }
  }

  await postToSlack(slackLines.join('\n'));
  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
