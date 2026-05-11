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
const MAX_PER_RUN       = parseInt(process.env.MAX_PER_RUN || '50', 10);
const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL     = process.env.SLACK_CHANNEL_AI_ENGINEERING;

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
  lastScraped:       'fldMSrStzASLj05cc',
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
      filterByFormula: `SEARCH("rapidapi.com", {${F.link}})`,
      fields: [F.name, F.link, F.lastScraped],
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

  console.log(`      About: ${about ? about.slice(0, 60) + '…' : '(none)'}`);
  console.log(`      Dev: ${developerName} | Category: ${category || '(none)'}`);
  console.log(`      Pop: ${popularityScore} | Latency: ${avgLatency}ms | Success: ${successRate}% | Endpoints: ${endpointCount}`);

  return { about: about || null, developerName: developerName || null, developerUrl: developerUrl || null,
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

// ─── Endpoints Page ───────────────────────────────────────────────────────────

async function scrapeEndpoints(page, baseUrl) {
  console.log(`    → Endpoints (overview page sidebar)`);
  // The endpoint list lives in the left sidebar of the overview page.
  // Navigate back to the base URL (pricing page is still showing).
  try {
    await gotoAndDismissCookies(page, baseUrl);
  } catch (e) {
    console.warn(`    ⚠️  Endpoints nav failed: ${e.message}`);
    return null;
  }

  await page.screenshot({ path: `/tmp/rapidapi-enrich-endpoints-${Date.now()}.png` }).catch(() => {});

  const endpointData = await page.evaluate(() => {
    const result = { endpointList: [], apiHost: '', curlCommands: '', testResults: '' };

    // ── Left sidebar endpoint list ────────────────────────────────────────
    // RapidAPI left nav contains endpoint group names and individual endpoint items.
    // The sidebar links look like: GET /search, POST /upload, etc.
    // They appear as <a> or <li> elements in the left nav column.
    const sidebar = document.querySelector(
      'nav[class*="sidebar"], [class*="Sidebar"], [class*="left-nav"], [class*="LeftNav"], ' +
      '[class*="endpoint-nav"], aside, [role="navigation"]'
    );

    // Navigation items that appear in the sidebar but are NOT endpoints
    const NAV_NOISE = new Set([
      'api overview', 'endpoints', 'search endpoints', 'mcp playground',
      'overview', 'tutorials', 'changelog', 'discussions', 'about',
      'playground', 'versions', 'sign in', 'sign up', 'log in', 'login',
      'get started', 'discovery', 'workspace',
    ]);

    function isEndpoint(text) {
      const lower = text.toLowerCase().trim();
      if (!lower || lower.length > 120) return false;
      if (NAV_NOISE.has(lower)) return false;
      // Heuristic: endpoint names are short, don't look like nav items
      if (/^(sign|log|get started|discover|workspace)/i.test(lower)) return false;
      return true;
    }

    if (sidebar) {
      const links = Array.from(sidebar.querySelectorAll('a, li, [class*="endpoint"], [class*="Endpoint"]'))
        .map(el => el.textContent.trim())
        .filter(isEndpoint);
      result.endpointList = [...new Set(links)].slice(0, 50);
    }

    // Fallback: look for anything that looks like an HTTP method + path
    if (!result.endpointList.length) {
      const allLinks = Array.from(document.querySelectorAll('a'))
        .map(a => a.textContent.trim())
        .filter(text =>
          text.length < 100 &&
          (text.startsWith('/') || /^(GET|POST|PUT|DELETE|PATCH|HEAD)\s/i.test(text))
        );
      result.endpointList = [...new Set(allLinks)].slice(0, 50);
    }

    // ── API host from page ────────────────────────────────────────────────
    // The API's actual hostname (e.g. "soundcloud-scraper.p.rapidapi.com") appears
    // in curl examples, code snippets, or the "x-rapidapi-host" header value.
    const fullText = document.body.innerText;
    const hostMatch = fullText.match(/[\w-]+\.p\.rapidapi\.com/);
    if (hostMatch) result.apiHost = hostMatch[0];

    // ── Curl commands from code blocks ────────────────────────────────────
    const codeBlocks = Array.from(document.querySelectorAll('code, pre, [class*="code"], [class*="Code"], [class*="curl"]'));
    const curls = [];
    for (const block of codeBlocks) {
      const t = block.textContent.trim();
      if (t.toLowerCase().includes('curl') || t.includes('x-rapidapi')) {
        curls.push(t.slice(0, 800));
        if (curls.length >= 3) break;
      }
    }
    result.curlCommands = curls.join('\n\n---\n\n');

    // ── Test result ───────────────────────────────────────────────────────
    const ep = result.endpointList.length;
    result.testResults = ep > 0
      ? `✅ ${ep} endpoint(s) found in sidebar`
      : `⚠️ Page loaded — no endpoints visible (may require auth or API has none listed)`;

    return result;
  }).catch(e => {
    console.warn(`    ⚠️  Endpoints evaluate error: ${e.message}`);
    return null;
  });

  if (endpointData) {
    console.log(`      Endpoints: ${endpointData.endpointList.length} | Host: ${endpointData.apiHost || '(none)'}`);
  }
  return endpointData;
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
  console.log(`   Rescrape window: ${RESCRAPE_DAYS}d | Max per run: ${MAX_PER_RUN}\n`);

  // ── Fetch all RapidAPI APIs from Airtable ─────────────────────────────────
  console.log('Fetching APIs from Airtable…');
  const apis = await getAllRapidAPIAPIs();
  console.log(`  Found ${apis.length} RapidAPI APIs\n`);

  // ── Filter: skip recently scraped ─────────────────────────────────────────
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RESCRAPE_DAYS);

  const toProcess = apis
    .filter(api => api.link && (!api.lastScraped || new Date(api.lastScraped) < cutoff))
    .slice(0, MAX_PER_RUN);

  const skipped = apis.length - toProcess.length;
  console.log(`  Skipping ${skipped} recently scraped (within ${RESCRAPE_DAYS}d)`);
  console.log(`  Processing ${toProcess.length} APIs\n`);

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
      const eps = await scrapeEndpoints(page, baseUrl);
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
