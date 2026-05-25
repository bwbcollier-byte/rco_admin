/**
 * Marie — RapidAPI Data Enricher
 *
 * Reads every API in the Airtable APIs table whose Link contains "rapidapi.com",
 * visits three page types per API, and writes back the enrichment fields.
 *
 * ── What gets scraped ─────────────────────────────────────────────────────────
 *   Overview page:  About, Developer Name, Developer URL, Endpoint Count,
 *                   Popularity Score, Avg Latency (ms), Success Rate %
 *   Pricing page:   Free Tier Details, Rate Limit, Overage Price,
 *                   Calls Per Month, Free Quota Per Month, Subscription Notes
 *   Playground:     Endpoints (list), Endpoint (base URL), Curl Commands,
 *                   Test Results, MCP Endpoint
 *
 * ── What is NOT scraped ───────────────────────────────────────────────────────
 *   Name, RapidAPI Status, Auth Method, Subscription Date, Subscription Plan,
 *   Used This Month, Last Failure At, Consecutive Failures
 *
 * ── Required env vars ────────────────────────────────────────────────────────
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 *   AIRTABLE_APIS         (table ID — defaults to tblMb9HFyKcnQ7aKb)
 *
 * ── Optional env vars ────────────────────────────────────────────────────────
 *   DRY_RUN=true          scrape but do not write to Airtable
 *   HEADLESS=false        show browser (useful for local debugging)
 *   RESCRAPE_DAYS=7       skip APIs with Last Scraped within this many days
 *   MAX_PER_RUN=50        hard cap on APIs processed per run
 *   SLACK_BOT_TOKEN       post summary to Slack when done
 *   SLACK_CHANNEL_AI_ENGINEERING
 */

// Auto-load .env for local runs; no-op on GitHub Actions.
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());
const axios = require('axios');

// ─── Config ───────────────────────────────────────────────────────────────────

const AIRTABLE_API_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID  = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_APIS     = process.env.AIRTABLE_APIS || 'tblMb9HFyKcnQ7aKb';
const DRY_RUN           = process.env.DRY_RUN === 'true';
const HEADLESS          = process.env.HEADLESS !== 'false';
const RESCRAPE_DAYS     = parseInt(process.env.RESCRAPE_DAYS || '7', 10);
const MAX_PER_RUN       = parseInt(process.env.MAX_PER_RUN || '999', 10);
const FORCE             = process.env.FORCE === 'true';  // skip lastScraped filter entirely
const RAPIDAPI_KEY      = process.env.RAPIDAPI_KEY;   // primary key for live test calls
// All available keys — used for rotation on 403 before falling back to subscribe
const ALL_RAPIDAPI_KEYS = (process.env.RAPIDAPI_KEYS || process.env.RAPIDAPI_KEY || '')
  .split(',').map(k => k.trim()).filter(Boolean);
// Airtable Logins table (for auto-subscribe when all keys return 403)
const AIRTABLE_LOGINS   = process.env.AIRTABLE_LOGINS || 'tbldJkG11gY1W3jTf';
// No hard cap on endpoints — scrape and test every endpoint in the sidebar.
// Override with MAX_ENDPOINTS=N env var only if you want to limit for speed.
const MAX_ENDPOINTS     = parseInt(process.env.MAX_ENDPOINTS || '999', 10);
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL     = process.env.SLACK_CHANNEL_AI_ENGINEERING;

// Session state — set once after login, reused across all APIs in the run
let SESSION_API_KEY   = RAPIDAPI_KEY;
let SESSION_LOGGED_IN = false;
let SESSION_LOGIN_ID  = null;  // Airtable record ID of the logged-in Login record

// Airtable field IDs (from tblMb9HFyKcnQ7aKb schema)
const F = {
  name:              'fldgEt7Po7CBXvA71',
  developerName:     'fldtr3JUxQpvkb4us',
  link:              'fld0SuLIJPIGM4UTY',
  about:             'fld6t5xv5ejuni3pI',
  developerUrl:      'fldQe4uytrGtQaFIf',
  endpointCount:     'fldWeZB3aDJKUlvRQ',
  endpoints:         'flduRXxFwC4nVHO9D',
  popularityScore:   'fldWaebfx9RtBy0D1',
  avgLatency:        'fldes47dcJOmUn7pU',
  successRate:       'fldGUaJP62BNz87uw',
  freeTierDetails:   'fldh0ShjqkmK66aM2',
  testResults:       'fldGgAczdqxLJ6NsT',
  curlCommands:      'fldCIt3af3pDpFK6R',
  mcpEndpoint:       'fldhYHa6TpB57edaE',
  status:            'fldFSB4dK0bVRbt0R',
  decision:          'fldbpVmC9myu1dk0T',
  dateFound:         'fldstJZi2oybRW4rj',
  lastScraped:       'fldMSrStzASLj05cc',
  subscribed:        'fldFBb9KjAeY1XCsn',
  subscribedAccounts:'fldC1SyTRoYmFLlRI',
  subscriptionNotes: 'fldOyYLNNC2EBKQQm',
  callsPerMonth:     'fldq9u4Y4xHjC0LJv',
  rateLimit:         'fldvyvWhQMmifwCI9',
  overagePrice:      'fldPJeE1R0RTOFyQU',
  freeQuotaPerMonth: 'fldW2ieuXofxAyuYE',
  endpoint:          'fldV06krV0Z866foz',
};

// ─── Airtable helpers ─────────────────────────────────────────────────────────

async function getAllRapidAPIAPIs() {
  const results = [];
  let offset = null;
  do {
    const params = {
      returnFieldsByFieldId: true,
      // Discovered = needs first enrichment. Error = previous run failed (retry).
      filterByFormula: `AND(SEARCH("rapidapi.com", {${F.link}}), OR({${F.status}}="Discovered", {${F.status}}="Error"))`,
      fields: [F.name, F.link, F.lastScraped, F.dateFound, F.decision, F.status],
      pageSize: 100,
    };
    if (offset) params.offset = offset;

    const res = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}`,
      { params, headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );

    for (const r of (res.data.records || [])) {
      results.push({
        id:          r.id,
        name:        r.fields[F.name] || '(unnamed)',
        link:        r.fields[F.link] || '',
        lastScraped: r.fields[F.lastScraped] || null,
        dateFound:   r.fields[F.dateFound]   || null,
        decision:    r.fields[F.decision]    || null,
        status:      r.fields[F.status]      || null,
      });
    }
    offset = res.data.offset || null;
  } while (offset);

  return results;
}

/** Write enrichment fields one-by-one so a bad field never blocks others. */
async function updateAPIRecord(recordId, data) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would update ${recordId}: ${Object.keys(data).join(', ')}`);
    return;
  }
  const url     = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}/${recordId}`;
  const headers = { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

  for (const [fieldId, value] of Object.entries(data)) {
    if (value === null || value === undefined || value === '') continue;
    try {
      await axios.patch(url, { fields: { [fieldId]: value } }, { headers });
    } catch (e) {
      const status = e.response?.status;
      if (status === 422) {
        console.warn(`    ⚠️  Skip field ${fieldId}: ${e.response?.data?.error?.message || 'unprocessable'}`);
      } else {
        console.warn(`    ⚠️  Write error field ${fieldId}: HTTP ${status || e.message}`);
      }
    }
  }
}

// ─── Browser helpers ──────────────────────────────────────────────────────────

/**
 * Navigate and dismiss the RapidAPI cookie consent banner.
 * Must be called after every page.goto() because the banner reappears on
 * each page load until cookies are set (and in headless mode cookies don't
 * persist across navigations unless we store them in context).
 */
async function gotoAndDismissCookies(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  // Let React hydrate and inject the cookie banner
  await page.waitForTimeout(2500);

  // Cookie banner — click Reject All then wait for it to vanish
  for (let attempt = 0; attempt < 2; attempt++) {
    const rejectBtn = page.locator('button:has-text("Reject All")');
    const visible = await rejectBtn.first().isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) break; // banner gone (or never appeared)

    await rejectBtn.first().click();
    // Wait for banner to leave the DOM (confirms it was actually dismissed)
    try {
      await page.waitForSelector('button:has-text("Reject All")', { state: 'detached', timeout: 4000 });
    } catch {
      await page.waitForTimeout(1500);
    }
    break;
  }

  // Final settle for React re-render after banner close
  await page.waitForTimeout(2000);
}

/**
 * Find the value displayed next to a specific label in the page.
 * Handles both exact-match labels and labels that also contain tooltip icons
 * (whose .textContent would be "Category[icon char]" etc.).
 *
 * Walks leaf-ish elements whose trimmed text starts with the label, then
 * searches nearby siblings for the value.
 */
async function extractLabelValue(page, labelText) {
  return page.evaluate((label) => {
    // Walk all elements — look for ones whose text STARTS with the label
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      // Only small/leaf elements (labels are never big containers)
      if (el.children.length > 3) continue;
      const text = el.textContent.trim();
      if (!text.startsWith(label)) continue;
      if (text.length > label.length + 10) continue; // too much extra text → skip

      // 1. Next sibling of this element
      const sib = el.nextElementSibling;
      if (sib) {
        const t = sib.textContent.trim();
        if (t && t !== label && t.length > 0) return t;
      }
      // 2. Parent's next sibling
      const parentSib = el.parentElement?.nextElementSibling;
      if (parentSib) {
        const t = parentSib.textContent.trim();
        if (t && t !== label && t.length > 0) return t;
      }
      // 3. Grandparent's next sibling
      const gpSib = el.parentElement?.parentElement?.nextElementSibling;
      if (gpSib) {
        const t = gpSib.textContent.trim();
        if (t && t !== label && t.length > 0) return t;
      }
    }
    return '';
  }, labelText);
}

/** Parse a positive number from a string, handling commas, K/M suffixes. */
function parseNum(str) {
  if (!str) return null;
  const s = str.toString().trim();
  const m = s.match(/([\d,]+\.?\d*)\s*([KkMm])?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (isNaN(n) || n <= 0) return null;
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K') n *= 1000;
  if (suf === 'M') n *= 1000000;
  return Math.round(n * 100) / 100;
}

// ─── Login + Auto-subscribe ───────────────────────────────────────────────────

/** Fetch the first Active RapidAPI login from Airtable. */
async function getFirstActiveLogin() {
  try {
    const res = await axios.get(
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_LOGINS}`,
      {
        params: {
          filterByFormula: `AND({Status}='Active', {Name}='RapidAPI')`,
          maxRecords: 1,
          fields: ['Login', 'Password'],  // field display names
        },
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
      }
    );
    const r = res.data.records?.[0];
    if (!r) return null;
    const email    = r.fields['Login'];
    const password = r.fields['Password'];
    if (!email || !password) return null;
    return { id: r.id, email, password };
  } catch (e) {
    console.warn(`  ⚠️ Could not fetch login: ${e.message}`);
    return null;
  }
}

/** Log into RapidAPI (email → Next → password → Submit). */
async function loginToRapidAPI(page, email, password) {
  await page.goto('https://rapidapi.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Dismiss cookie banner if it appears
  try {
    const rejectBtn = page.locator('button:has-text("Reject All")').first();
    if (await rejectBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await rejectBtn.click();
      await page.waitForTimeout(800);
    }
  } catch {}

  // Fill email
  await page.locator('input[type="email"], input[name="email"]').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('input[type="email"], input[name="email"]').first().fill(email);
  await page.waitForTimeout(500);

  // Click Next (may be labelled "Next", "Continue", or just a submit)
  const nextBtn = page.locator('button:has-text("Next"), button:has-text("Continue"), button[type="submit"]').first();
  await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
  await nextBtn.click();
  await page.waitForTimeout(3000);

  // Fill password
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('input[type="password"]').first().fill(password);
  await page.waitForTimeout(500);

  // Submit
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(9000);

  const url = page.url();
  if (url.includes('/auth/login') || url.includes('/auth/sign')) {
    throw new Error(`Login failed — still on: ${url}`);
  }
  console.log(`  ✅ Logged in as ${email}`);
}

/**
 * Subscribe to an API's free plan using the already-logged-in Playwright page.
 * Navigates to the pricing page, clicks "Start Free Plan" (if visible), and
 * confirms any modal. Returns true if a subscribe click happened.
 */
async function subscribeViaPlaywright(page, baseUrl) {
  const pricingUrl = baseUrl.replace(/\/+$/, '') + '/pricing';
  try {
    await page.goto(pricingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

    // Already subscribed?
    const isSubscribed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, a')];
      return btns.some(el => /cancel plan|current plan|upgrade plan/i.test(el.textContent));
    });
    if (isSubscribed) { console.log(`    Already subscribed — no action`); return false; }

    // Click "Start Free Plan"
    const freeBtn = page.locator('button:has-text("Start Free Plan"), a:has-text("Start Free Plan")').first();
    if (await freeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await freeBtn.click();
      await page.waitForTimeout(3000);
      // Confirm modal if it appears
      try {
        await page.locator('button:has-text("Confirm"), button:has-text("Yes"), button:has-text("Subscribe")').first().click({ timeout: 4000 });
        await page.waitForTimeout(2000);
      } catch {}
      console.log(`    ✅ Subscribed via Playwright`);
      return true;
    }
    console.log(`    ⚠️ Start Free Plan button not found`);
    return false;
  } catch (e) {
    console.warn(`    ⚠️ Subscribe attempt failed: ${e.message.slice(0, 80)}`);
    return false;
  }
}

/**
 * Extract the x-rapidapi-key from the logged-in developer apps page.
 * Tries /developer/apps table → app security tab → page text scan.
 */
async function grabAPIKey(page) {
  async function scanPage() {
    return page.evaluate(() => {
      for (const input of document.querySelectorAll('input')) {
        const v = (input.value || input.defaultValue || '').trim();
        if (v.length >= 30 && /^[a-zA-Z0-9]+$/.test(v)) return v;
      }
      const m = document.body.innerText.match(/x-rapidapi-key["'\s:]+([a-zA-Z0-9]{30,})/i);
      return m ? m[1] : null;
    });
  }
  try {
    await page.goto('https://rapidapi.com/developer/apps', { waitUntil: 'domcontentloaded', timeout: 30000 });
    let appName = null;
    try {
      await page.waitForSelector('table tbody tr td', { timeout: 15000 });
      appName = (await page.locator('table tbody tr td:first-child').first().textContent()).trim();
    } catch {}

    if (appName) {
      await page.goto(`https://rapidapi.com/developer/apps/${encodeURIComponent(appName)}/security`, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(4000);
      const key = await scanPage();
      if (key) return key;
    }
  } catch {}
  return null;
}

// ─── Overview Page ────────────────────────────────────────────────────────────

async function scrapeOverview(page, baseUrl) {
  console.log(`    → Overview: ${baseUrl}`);
  try {
    await gotoAndDismissCookies(page, baseUrl);
  } catch (e) {
    console.warn(`    ⚠️  Navigation failed: ${e.message}`);
    return null;
  }

  await page.screenshot({ path: `/tmp/rapidapi-enrich-overview-${Date.now()}.png` }).catch(() => {});

  // ── API Name — from <h1> or breadcrumb ───────────────────────────────────
  const apiName = await page.evaluate(() => {
    // <h1> is the most reliable; it contains the API's display name
    for (const el of document.querySelectorAll('h1')) {
      const t = el.textContent.trim();
      // Skip very short or very long (likely a layout heading, not the API name)
      if (t.length > 3 && t.length < 120) return t;
    }
    // Fallback: last breadcrumb link that isn't "Categories"
    const bcLinks = Array.from(document.querySelectorAll(
      '[class*="breadcrumb"] a, [aria-label*="breadcrumb"] a, ol a'
    )).map(a => a.textContent.trim()).filter(t => t && t.toLowerCase() !== 'categories');
    return bcLinks[bcLinks.length - 1] || '';
  }).catch(() => '');

  // ── Developer info ─────────────────────────────────────────────────────────
  // Most reliable source: parse from URL (slug is the developer identifier)
  let developerName = '';
  let developerUrl  = '';
  try {
    const parts   = new URL(baseUrl).pathname.split('/').filter(Boolean);
    developerName = parts[0] || '';  // rapidapi.com/{developer}/api/{api-name}
    developerUrl  = developerName ? `https://rapidapi.com/${developerName}` : '';
  } catch {}

  // Try to get the display name from the right-sidebar "API Creator" section
  const apiCreator = await extractLabelValue(page, 'API Creator');
  if (apiCreator && apiCreator.length < 80) developerName = apiCreator.trim() || developerName;

  // ── Description / About ───────────────────────────────────────────────────
  // RapidAPI renders the description as long paragraph(s) in the main content area.
  // It appears after the plan tabs (Basic/Pro/Ultra etc.) in the Overview tab.
  const about = await page.evaluate(() => {
    function looksLikeDescription(t) {
      if (t.length < 80) return false;
      if (t.includes('{') || t.includes('data-radix') || t.includes('Sign InSign Up')) return false;
      if (/^(Search|Sign|Log|Accept|Reject|Manage|Cookie|Privacy|These cookies|RapidAPI partners|Back Button)/i.test(t)) return false;
      if (/cookies are necessary|tracking technolog|cookie policy|consent banner/i.test(t)) return false;
      // Nav text concatenated without spaces (headless rendering artifact)
      if (/DiscoveryWorkspace|WorkspaceSign|Sign InSign|API OverviewVersion|Cookie List.*Search Icon/i.test(t)) return false;
      if (t.split(' ').length < 10) return false;
      return true;
    }

    // Strategy 1: <p> tags in main content area
    const paras = Array.from(document.querySelectorAll('main p, [role="main"] p, article p, [id*="content"] p'))
      .map(p => p.textContent.trim())
      .filter(looksLikeDescription);
    if (paras.length) return paras.sort((a, b) => b.length - a.length)[0].slice(0, 3000);

    // Strategy 2: all paragraphs on the page
    const allParas = Array.from(document.querySelectorAll('p'))
      .map(p => p.textContent.trim())
      .filter(looksLikeDescription);
    if (allParas.length) return allParas.sort((a, b) => b.length - a.length)[0].slice(0, 3000);

    // Strategy 3: small divs that look like descriptions
    const divs = Array.from(document.querySelectorAll('div, section'))
      .filter(el => el.children.length <= 2)
      .map(el => el.textContent.trim())
      .filter(t => looksLikeDescription(t) && !t.includes('Requests') && !t.includes('/Month'));
    if (divs.length) return divs.sort((a, b) => b.length - a.length)[0].slice(0, 3000);

    return '';
  });

  // ── Stats — parse from full page text ────────────────────────────────────
  // RapidAPI stats bar format (NUMBER before LABEL):
  //   "8.4 Popularity | 1324ms Avg Latency | 90.6% Subs Success Rate"
  // extractLabelValue won't work here — we need regex on the full page text.
  const pageText = await page.evaluate(() => document.body.innerText || '');

  const popMatch     = pageText.match(/([\d.]+)\s*(?:Popularity Score|Popularity)(?:\s*\||\s*\n|\s*$)/i);
  const latencyMatch = pageText.match(/([\d]+)\s*ms\s*(?:Avg\.?\s*Latency|Latency)/i);
  // Success rate format: "90.6% Subs Success Rate" or "99.5% Success Rate" or "Success Rate: 99%"
  const srMatch      = pageText.match(/([\d.]+)\s*%\s*(?:Subs\s+)?Success\s*Rate/i)
                    || pageText.match(/Success\s*Rate[:\s]+([\d.]+)\s*%/i)
                    || pageText.match(/([\d.]+)\s*%\s*Success/i);

  const popularityScore = parseNum(popMatch?.[1]);
  const avgLatency      = parseNum(latencyMatch?.[1]);
  const successRate     = parseNum(srMatch?.[1]);
  let   endpointCount   = null;  // filled from the endpoints sidebar (more accurate)

  // ── Category — link to /categor(ies|y)/ in the breadcrumb ──────────────────
  // RapidAPI breadcrumb: "< Categories > {Category Name} > API Name"
  // The category link has an href containing "/categor" — much more reliable than
  // walking generic nav elements (which would pick up sidebar items like "API Overview").
  const category = await page.evaluate(() => {
    // Most reliable: category browse links always go to /categories/{name} (with trailing slash).
    // Endpoint links that happen to contain "category" in the path (e.g. /endpoints/categorydetail)
    // do NOT match /categories/ so they're excluded automatically.
    const catLinks = Array.from(document.querySelectorAll('a[href*="/categories/"], a[href*="/category/"]'))
      .map(a => a.textContent.trim())
      .filter(t => t && t.toLowerCase() !== 'categories' && t.length < 80
             && !/^(GET|POST|PUT|DELETE|PATCH)/i.test(t));  // not an HTTP method label
    if (catLinks.length) return catLinks[0];

    // Fallback: right sidebar label matching "Category"
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      if (el.children.length > 3) continue;
      const text = el.textContent.trim();
      if (!text.toLowerCase().startsWith('category') || text.length > 20) continue;
      const sib = el.nextElementSibling;
      if (sib) { const t = sib.textContent.trim(); if (t && t.length < 80) return t; }
      const parentSib = el.parentElement?.nextElementSibling;
      if (parentSib) { const t = parentSib.textContent.trim(); if (t && t.length < 80) return t; }
    }
    return '';
  });

  // ── MCP tab ───────────────────────────────────────────────────────────────
  let mcpEndpoint = '';
  try {
    const mcpEl = page.locator('a:has-text("MCP"), [href*="/mcp"]').first();
    if (await mcpEl.isVisible({ timeout: 2000 }).catch(() => false)) {
      const href = await mcpEl.getAttribute('href').catch(() => '');
      mcpEndpoint = href
        ? (href.startsWith('http') ? href : `https://rapidapi.com${href}`)
        : `${baseUrl}/mcp`;
    }
  } catch {}
  // Construct a candidate MCP URL even if not found
  if (!mcpEndpoint) mcpEndpoint = `${baseUrl}/mcp`;

  console.log(`      Name: ${apiName || '(none)'} | Dev: ${developerName} | Category: ${category || '(none)'}`);
  console.log(`      About: ${about ? about.slice(0, 60) + '…' : '(none)'}`);
  console.log(`      Pop: ${popularityScore} | Latency: ${avgLatency}ms | Success: ${successRate}%`);

  return { name: apiName || null, about: about || null,
           developerName: developerName || null, developerUrl: developerUrl || null,
           popularityScore, avgLatency, successRate, endpointCount, mcpEndpoint: mcpEndpoint || null };
}

// ─── Pricing Page ─────────────────────────────────────────────────────────────

async function scrapePricing(page, baseUrl) {
  const pricingUrl = baseUrl.replace(/\/+$/, '') + '/pricing';
  console.log(`    → Pricing: ${pricingUrl}`);
  try {
    await gotoAndDismissCookies(page, pricingUrl);
  } catch (e) {
    console.warn(`    ⚠️  Pricing nav failed: ${e.message}`);
    return null;
  }

  await page.screenshot({ path: `/tmp/rapidapi-enrich-pricing-${Date.now()}.png` }).catch(() => {});

  const pricing = await page.evaluate(() => {
    const result = {
      freeTierDetails:   '',
      rateLimit:         '',
      callsPerMonth:     null,
      freeQuotaPerMonth: null,
      overagePrice:      null,
      subscriptionNotes: '',
    };

    // ── Find the free / Basic plan card ──────────────────────────────────
    // Most reliable anchor: the "Start Free Plan" button only exists in the free tier card.
    let freeCard = null;

    // Strategy 1: walk up from "Start Free Plan" button
    const allBtns = document.querySelectorAll('button, a');
    for (const btn of allBtns) {
      if (!btn.textContent.trim().includes('Start Free Plan')) continue;
      let el = btn.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!el) break;
        // The card is the smallest ancestor that has both a price AND requests info
        if (el.textContent.match(/\/\s*Month/i) && el.textContent.match(/\$[\d]/)) {
          freeCard = el;
          // Keep climbing until the container gets too big (i.e., includes other plans)
          const parent = el.parentElement;
          if (parent && parent.textContent.includes('Choose This Plan')) break; // found the right level
        }
        el = el.parentElement;
      }
      break;
    }

    // Strategy 2: find the first card with "Basic" + "/ Month"
    if (!freeCard) {
      const candidates = Array.from(document.querySelectorAll('*'))
        .filter(el => el.children.length >= 2 && el.children.length <= 25)
        .filter(el => el.textContent.includes('Basic') && el.textContent.match(/\/\s*Month/i));
      // Pick the smallest one (most specific)
      candidates.sort((a, b) => a.textContent.length - b.textContent.length);
      if (candidates.length) freeCard = candidates[0];
    }

    if (freeCard) {
      const cardText = freeCard.textContent;

      // Free tier full text (trimmed)
      result.freeTierDetails = cardText.replace(/\s+/g, ' ').trim().slice(0, 600);

      // Rate Limit: "1000 requests per hour", "30 requests per minute", etc.
      const rlMatch = cardText.match(/(\d[\d,]*)\s*(requests?|req|calls?)\s+per\s+(second|minute|hour|day)/i);
      if (rlMatch) result.rateLimit = rlMatch[0].trim();

      // Calls/Quota per month: "5 / Month", "1,000 / Month", "500K / Month"
      const monthMatch = cardText.match(/([\d,]+[KkMm]?)\s*\/\s*Month/i);
      if (monthMatch) {
        const raw = monthMatch[1].toUpperCase();
        let n = parseFloat(raw.replace(/,/g, '').replace(/K$/, '')) * (raw.endsWith('K') ? 1000 : 1);
        if (!isNaN(n) && n > 0) {
          result.callsPerMonth     = n;
          result.freeQuotaPerMonth = n;
        }
      }

      // Overage / hard limit — look for "+ $X.XX" pattern in free card
      const overageMatch = cardText.match(/\+\s*\$([\d.]+)\s*per\s*(request|req|call|1[Mm][Bb]|MB)/i);
      if (overageMatch) {
        result.overagePrice = parseFloat(overageMatch[1]);
      }
    }

    // ── All plans summary for Subscription Notes ──────────────────────────
    // Grab plan cards by looking for elements that contain "/ Month" pricing
    const planContainers = Array.from(document.querySelectorAll('*'))
      .filter(el => {
        const t = el.textContent;
        return el.children.length >= 2
          && el.children.length <= 25
          && t.match(/\/\s*Month/i)
          && t.match(/\$[\d.]+/)
          && (t.includes('Basic') || t.includes('Pro') || t.includes('Free') || t.includes('Start'));
      });

    // De-dupe: take the smallest containers that still have the pricing content
    const planTexts = [];
    const seen = new Set();
    for (const el of planContainers) {
      const t = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 250);
      if (!seen.has(t)) { seen.add(t); planTexts.push(t); }
      if (planTexts.length >= 6) break;
    }
    result.subscriptionNotes = planTexts.join('\n\n').slice(0, 2000);

    return result;
  }).catch(e => {
    console.warn(`    ⚠️  Pricing evaluate error: ${e.message}`);
    return null;
  });

  if (pricing) {
    console.log(`      Rate limit: ${pricing.rateLimit || '(none)'} | Calls/mo: ${pricing.callsPerMonth || '(none)'}`);
  }
  return pricing;
}

// ─── Endpoints + Playground + Per-Endpoint Test Calls ────────────────────────

async function scrapeEndpoints(page, baseUrl, apiRecordId = null) {
  console.log(`    → Endpoints (all) + curl + test calls`);

  const NAV_NOISE = new Set([
    'api overview', 'endpoints', 'search endpoints', 'mcp playground',
    'overview', 'tutorials', 'changelog', 'discussions', 'about',
    'playground', 'versions', 'sign in', 'sign up', 'log in', 'login',
    'get started', 'discovery', 'workspace', 'open playground',
  ]);

  // ── Step 1: Overview page — collect all endpoint hrefs from the sidebar ────
  try {
    await gotoAndDismissCookies(page, baseUrl);
  } catch (e) {
    console.warn(`    ⚠️  Overview nav failed: ${e.message}`);
    return null;
  }

  await page.screenshot({ path: `/tmp/rapidapi-enrich-endpoints-${Date.now()}.png` }).catch(() => {});

  // Grab every sidebar link that looks like an endpoint (has /playground/ or /endpoints/ in href)
  // PLUS collect the display names for the endpointList field.
  const sidebarInfo = await page.evaluate((noiseArr) => {
    const NAV_NOISE = new Set(noiseArr);
    const sidebar = document.querySelector(
      'nav[class*="sidebar"], [class*="Sidebar"], [class*="left-nav"], aside, [role="navigation"]'
    );
    const links = [];
    const names = [];
    let apiHost = '';
    let playgroundBase = '';

    if (sidebar) {
      for (const a of sidebar.querySelectorAll('a')) {
        const text = a.textContent.trim();
        const href = a.href || '';
        const lower = text.toLowerCase();

        // "Open playground" base URL
        if (/open playground/i.test(text) && href) {
          playgroundBase = href;
          continue;
        }
        // Skip nav noise
        if (!text || text.length > 120 || NAV_NOISE.has(lower)) continue;
        if (/^(sign|log|get started|discover|workspace)/i.test(lower)) continue;

        // Clean up label: sidebar items have the HTTP method badge text glued
      // directly onto the endpoint name (e.g. "GETFetch Latest Jobs").
      // Insert a space after the method so it reads "GET Fetch Latest Jobs".
      const cleanText = text.replace(/^(GET|POST|PUT|DELETE|PATCH|HEAD)([A-Z\s])/,
        (_, method, next) => `${method} ${next}`);

      // Endpoint link — must go to playground or endpoint detail
      if (href && (href.includes('/playground') || href.includes('/endpoint'))) {
        links.push({ text: cleanText, href });
      }
      names.push(cleanText);
      }
    }

    const m = document.body.innerText.match(/[\w-]+\.p\.rapidapi\.com/);
    if (m) apiHost = m[0];

    return { links, names: [...new Set(names)].slice(0, 50), apiHost, playgroundBase };
  }, [...NAV_NOISE]).catch(() => ({ links: [], names: [], apiHost: '', playgroundBase: '' }));

  let endpointList = sidebarInfo.names;
  let apiHost      = sidebarInfo.apiHost;

  // Fallback: if no endpoint links found via sidebar, use the playground base URL
  // to get the first available endpoint
  let endpointHrefs = sidebarInfo.links.slice(0, MAX_ENDPOINTS);
  if (!endpointHrefs.length) {
    const playUrl = sidebarInfo.playgroundBase || (baseUrl.replace(/\/+$/, '') + '/playground/requestDetails');
    endpointHrefs = [{ text: 'Default', href: playUrl }];
  }

  console.log(`      Sidebar: ${endpointList.length} endpoint names, ${endpointHrefs.length} playground links`);

  // ── Step 2: Visit each endpoint's playground page ─────────────────────────
  // For each endpoint: extract curl, parse URL, make test call, capture result.
  // Output is accumulated into multiline text fields with ### headers.

  const curlSections   = [];  // one per endpoint → goes into Curl Commands field
  const resultSections = [];  // one per endpoint → goes into Test Results field
  let   firstApiHost   = apiHost;

  // ── Per-API subscription state ────────────────────────────────────────────
  // Subscribe at most ONCE per API. Once done, all subsequent endpoints
  // in this API reuse the session key without re-subscribing.
  let subscribedThisAPI = false;

  // Shared axios helper
  async function tryCall(key, testUrl, testHost) {
    const res = await axios.get(testUrl, {
      headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': testHost },
      timeout: 12000, validateStatus: null,
    });
    const body = typeof res.data === 'object'
      ? JSON.stringify(res.data, null, 2).slice(0, 3000)
      : String(res.data).slice(0, 3000);
    return { status: res.status, body };
  }

  // Subscribe to the free plan for this API (called at most once per API).
  // Logs in if not already logged in, grabs the session key, then clicks
  // "Start Free Plan" on the pricing page.
  async function ensureSubscribed() {
    if (subscribedThisAPI) return true;  // already handled for this API

    console.log(`      → 403 detected — subscribing to free plan before continuing…`);

    if (!SESSION_LOGGED_IN) {
      const login = await getFirstActiveLogin();
      if (!login) {
        console.warn(`      No RapidAPI login available — cannot auto-subscribe`);
        return false;
      }
      try {
        await loginToRapidAPI(page, login.email, login.password);
        SESSION_LOGGED_IN = true;
        SESSION_LOGIN_ID  = login.id;
        const kp = await page.context().newPage();
        const k  = await grabAPIKey(kp);
        await kp.close().catch(() => {});
        if (k) SESSION_API_KEY = k;
      } catch (e) {
        console.warn(`      Login failed: ${e.message.slice(0, 80)}`);
        return false;
      }
    }

    await subscribeViaPlaywright(page, baseUrl);
    subscribedThisAPI = true;
    await page.waitForTimeout(2000);  // let subscription propagate before retry

    // Update Airtable: mark Subscribed + link this Login to the API record
    if (apiRecordId && SESSION_LOGIN_ID) {
      try {
        const url     = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${AIRTABLE_APIS}/${apiRecordId}`;
        const headers = { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' };

        // Set Subscribed checkbox
        await axios.patch(url, { fields: { [F.subscribed]: true } }, { headers });

        // Append this Login to Subscribed Accounts (linked records, no duplicates)
        const current = await axios.get(url, { headers });
        const existing = current.data.fields?.[F.subscribedAccounts] || [];
        if (!existing.includes(SESSION_LOGIN_ID)) {
          await axios.patch(url, { fields: { [F.subscribedAccounts]: [...existing, SESSION_LOGIN_ID] } }, { headers });
        }
        console.log(`      ✅ Airtable: Subscribed=true, linked Login ${SESSION_LOGIN_ID}`);
      } catch (e) {
        console.warn(`      ⚠️ Could not update Subscribed Accounts: ${e.message.slice(0, 80)}`);
      }
    }
    return true;
  }

  // Test one endpoint URL: try all keys first, subscribe once on 403, then retry.
  async function testEndpoint(testUrl, testHost) {
    // Pass 1: rotate all available keys
    for (const key of ALL_RAPIDAPI_KEYS) {
      try {
        const r = await tryCall(key, testUrl, testHost);
        if (r.status !== 403) return r;
      } catch {}
    }

    // All keys returned 403 — subscribe (at most once per API) then retry
    const ok = await ensureSubscribed();
    if (!ok) return null;

    // After subscribing, rotate all keys again — one of them belongs to the
    // account that just subscribed. SESSION_API_KEY may not be correct if
    // grabAPIKey failed at startup, so brute-force through all keys.
    for (const key of [SESSION_API_KEY, ...ALL_RAPIDAPI_KEYS]) {
      try {
        const r = await tryCall(key, testUrl, testHost);
        if (r.status !== 403) {
          SESSION_API_KEY = key;  // lock in the working key for future calls
          return r;
        }
      } catch {}
    }
    return null;
  }

  for (const ep of endpointHrefs) {
    try {
      await page.goto(ep.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000);

      // Extract curl + parse URL from this endpoint's code block
      const epData = await page.evaluate(() => {
        const r = { curl: '', testUrl: '', testHost: '', method: 'GET' };
        for (const el of document.querySelectorAll(
          'code, pre, [class*="code"], [class*="Code"], [class*="curl"], [class*="Curl"]'
        )) {
          const t = el.textContent.trim();
          if ((t.toLowerCase().includes('curl') || t.includes('x-rapidapi')) && t.includes('http')) {
            r.curl = t.slice(0, 1200);
            // Extract method
            const methM = t.match(/--request\s+(\w+)/i);
            if (methM) r.method = methM[1].toUpperCase();
            // Extract URL
            const urlM = t.match(/--url\s+['"]?(https?:\/\/[^\s'"]+)/i);
            if (urlM) {
              r.testUrl = urlM[1].replace(/['"]$/, '');
              const hM = r.testUrl.match(/\/\/([\w.-]+\.p\.rapidapi\.com)/);
              if (hM) r.testHost = hM[1];
            }
            break;
          }
        }
        if (!r.testHost) {
          const m = document.body.innerText.match(/[\w-]+\.p\.rapidapi\.com/);
          if (m) r.testHost = m[0];
        }
        return r;
      }).catch(() => ({ curl: '', testUrl: '', testHost: '', method: 'GET' }));

      if (!firstApiHost && epData.testHost) firstApiHost = epData.testHost;
      if (!apiHost && epData.testHost)      apiHost      = epData.testHost;

      const label = ep.text !== 'Default' ? ep.text : (epData.method + ' endpoint');

      // Curl section
      if (epData.curl) {
        curlSections.push(`### ${label}\n${epData.curl}`);
      }

      // Test call — only GET (POST/PUT/DELETE need a body we don't have)
      if (epData.testUrl && epData.testHost) {
        if (epData.method === 'GET') {
          console.log(`      Testing [${label}]: ${epData.testUrl.slice(0, 60)}`);
          const result = await testEndpoint(epData.testUrl, epData.testHost);
          if (result) {
            const emoji = result.status >= 200 && result.status < 300 ? '✅' : '❌';
            resultSections.push(`### ${label}\n${emoji} HTTP ${result.status}\n${result.body}`);
            console.log(`        → HTTP ${result.status}`);
          } else {
            resultSections.push(`### ${label}\n❌ All keys returned 403 — not subscribed`);
          }
        } else {
          // Non-GET: record the method but skip the live call
          resultSections.push(`### ${label}\n⏭ ${epData.method} — test call skipped (body required)`);
          console.log(`      [${label}] ${epData.method} — skipped`);
        }
      } else if (epData.curl) {
        resultSections.push(`### ${label}\n⚠️ Could not parse endpoint URL from curl`);
      }

    } catch (e) {
      console.warn(`      ⚠️ [${ep.text}] failed: ${e.message.slice(0, 80)}`);
    }

    // Brief pause between endpoint visits to be polite
    await page.waitForTimeout(1500);
  }

  const DIVIDER = '\n\n---\n\n';
  return {
    endpointList: endpointList,
    apiHost:      firstApiHost || apiHost,
    curlCommands: curlSections.join(DIVIDER),
    testResults:  resultSections.join(DIVIDER),
  };
}

// ─── Slack ────────────────────────────────────────────────────────────────────

async function postSlack(text) {
  if (!SLACK_BOT_TOKEN || !SLACK_CHANNEL) return;
  try {
    await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: SLACK_CHANNEL, text },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.warn(`Slack post failed: ${e.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔍 Marie — RapidAPI Enricher  ${DRY_RUN ? '[DRY RUN]' : ''}`);
  console.log(`   Rescrape window: ${FORCE ? 'FORCE (all)' : RESCRAPE_DAYS + 'd'} | Max per run: ${MAX_PER_RUN}\n`);

  // ── Fetch all RapidAPI APIs from Airtable ─────────────────────────────────
  console.log('Fetching APIs from Airtable…');
  const apis = await getAllRapidAPIAPIs();
  console.log(`  Found ${apis.length} RapidAPI APIs\n`);

  // ── Filter: skip recently scraped ─────────────────────────────────────────
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RESCRAPE_DAYS);

  const toProcess = apis
    .filter(api => {
      if (!api.link) return false;
      if (FORCE) return true;              // FORCE=true bypasses all date checks
      if (api.status === 'Error') return true;  // always retry failed records
      return !api.lastScraped || new Date(api.lastScraped) < cutoff;
    })
    .slice(0, MAX_PER_RUN);

  const skipped = apis.length - toProcess.length;
  if (FORCE) {
    console.log(`  FORCE mode — processing all ${toProcess.length} APIs`);
  } else {
    console.log(`  Skipping ${skipped} recently scraped (within ${RESCRAPE_DAYS}d)`);
    console.log(`  Processing ${toProcess.length} APIs`);
  }
  console.log();

  if (!toProcess.length) {
    console.log('Nothing to enrich — all APIs are up to date.');
    return;
  }

  // ── Launch browser ────────────────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // ── Optional: log in once so we can auto-subscribe on 403 ────────────────
  // Reads the first Active RapidAPI login from Airtable. If found, logs in
  // and grabs the session API key — used for all test calls this run.
  console.log('Checking for RapidAPI login credentials…');
  const login = await getFirstActiveLogin();
  if (login) {
    try {
      await loginToRapidAPI(page, login.email, login.password);
      SESSION_LOGGED_IN = true;
      SESSION_LOGIN_ID  = login.id;
      const keyPage = await context.newPage();
      const key = await grabAPIKey(keyPage);
      await keyPage.close().catch(() => {});
      if (key) {
        SESSION_API_KEY = key;
        console.log(`  Session key: ${key.slice(0, 8)}… | Login ID: ${login.id}\n`);
      }
    } catch (e) {
      console.warn(`  ⚠️ Login skipped: ${e.message.slice(0, 80)} — will still try key rotation\n`);
    }
  } else {
    console.log('  No RapidAPI login found — using key rotation only\n');
  }

  let enriched = 0;
  let failed   = 0;
  const issues = [];

  // ── Process each API ──────────────────────────────────────────────────────
  for (let i = 0; i < toProcess.length; i++) {
    const api = toProcess[i];
    console.log(`\n[${i + 1}/${toProcess.length}] ${api.name}`);
    console.log(`  URL: ${api.link}`);

    // Strip trailing /pricing, /endpoints, etc. to get the canonical base URL
    const baseUrl = api.link
      .replace(/\/(pricing|endpoints|tutorials|playground)\/?$/, '')
      .replace(/\/+$/, '');

    const assembled = {};

    try {
      // 1. Overview
      const overview = await scrapeOverview(page, baseUrl);
      if (overview) {
        if (overview.name)            assembled[F.name]           = overview.name;
        if (overview.about)           assembled[F.about]          = overview.about;
        if (overview.developerName)   assembled[F.developerName]  = overview.developerName;
        if (overview.developerUrl)    assembled[F.developerUrl]   = overview.developerUrl;
        if (overview.popularityScore) assembled[F.popularityScore]= overview.popularityScore;
        if (overview.avgLatency)      assembled[F.avgLatency]     = overview.avgLatency;
        if (overview.successRate)     assembled[F.successRate]    = overview.successRate;
        if (overview.endpointCount)   assembled[F.endpointCount]  = overview.endpointCount;
        if (overview.mcpEndpoint)     assembled[F.mcpEndpoint]    = overview.mcpEndpoint;
      }

      // 2. Pricing
      const pricing = await scrapePricing(page, baseUrl);
      if (pricing) {
        if (pricing.freeTierDetails)   assembled[F.freeTierDetails]   = pricing.freeTierDetails;
        if (pricing.rateLimit)         assembled[F.rateLimit]         = pricing.rateLimit;
        if (pricing.callsPerMonth)     assembled[F.callsPerMonth]     = pricing.callsPerMonth;
        if (pricing.freeQuotaPerMonth) assembled[F.freeQuotaPerMonth] = pricing.freeQuotaPerMonth;
        if (pricing.overagePrice)      assembled[F.overagePrice]      = pricing.overagePrice;
        if (pricing.subscriptionNotes) assembled[F.subscriptionNotes] = pricing.subscriptionNotes;
      }

      // 3. Endpoints
      const eps = await scrapeEndpoints(page, baseUrl, api.id);
      if (eps) {
        if (eps.endpointList.length) {
          assembled[F.endpoints]    = eps.endpointList.join('\n');
          // Only overwrite endpointCount if we haven't got a better one already
          if (!assembled[F.endpointCount]) assembled[F.endpointCount] = eps.endpointList.length;
        }
        if (eps.apiHost)      assembled[F.endpoint]     = eps.apiHost;
        if (eps.curlCommands) assembled[F.curlCommands] = eps.curlCommands;
        if (eps.testResults)  assembled[F.testResults]  = eps.testResults;
      }

      // Always stamp Last Scraped
      assembled[F.lastScraped] = new Date().toISOString().split('T')[0];

      // Status: Error if any test returned 403 or timed out, otherwise Processing
      const testText = assembled[F.testResults] || '';
      const hasError = /HTTP 40[0-9]|ECONNABORTED|timeout of \d+ms exceeded/i.test(testText);
      assembled[F.status] = hasError ? 'Error' : 'Processing';

      // Date Found: default to today if not already set
      if (!api.dateFound) assembled[F.dateFound] = new Date().toISOString().split('T')[0];

      // Decision: default to Pending if not already set
      if (!api.decision) assembled[F.decision] = 'Pending';

      const count = Object.keys(assembled).length;
      console.log(`  → Writing ${count} field(s) to Airtable`);
      await updateAPIRecord(api.id, assembled);
      enriched++;
      console.log(`  ✅ Done`);

    } catch (e) {
      failed++;
      const msg = e.message || String(e);
      issues.push(`${api.name}: ${msg.slice(0, 100)}`);
      console.error(`  ❌ Failed: ${msg.slice(0, 150)}`);
      await page.screenshot({ path: `/tmp/rapidapi-enrich-error-${Date.now()}.png` }).catch(() => {});
    }

    // Polite delay between APIs (3–5 s)
    if (i < toProcess.length - 1) {
      const delay = 3000 + Math.floor(Math.random() * 2000);
      console.log(`  Pausing ${(delay / 1000).toFixed(1)}s…`);
      await page.waitForTimeout(delay);
    }
  }

  await browser.close();

  // ── Summary ───────────────────────────────────────────────────────────────
  const emoji   = failed === 0 ? '✅' : enriched > 0 ? '⚠️' : '❌';
  const summary = [
    `${emoji} *RapidAPI Enricher complete*`,
    `• Processed: ${toProcess.length} APIs`,
    `• Enriched:  ${enriched}`,
    `• Failed:    ${failed}`,
    `• Skipped (fresh): ${skipped}`,
    ...(DRY_RUN ? ['• DRY RUN — no Airtable writes'] : []),
    ...(issues.length ? [`\n*Issues:*\n${issues.map(x => `  - ${x}`).join('\n')}`] : []),
  ].join('\n');

  console.log('\n' + summary.replace(/\*/g, ''));
  await postSlack(summary);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
