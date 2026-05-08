/**
 * Marie — Orchestrator
 * Runs all Marie automation tasks on a schedule.
 *
 * Runs every hour via GitHub Actions. Each task declares when it should fire.
 * Tasks are isolated — one failure won't block others.
 *
 * Tasks:
 *   - Social Apartment Monitor  → every 4 hours (UTC hours 0, 4, 8, 12, 16, 20)
 *   - Gym Class Booker          → 11am UTC daily (= 9pm AEST)
 *
 * Manual dispatch: set TASK env var to 'apartment', 'gym', or 'all' to force a specific task.
 *
 * Secrets required:
 *   SLACK_BOT_TOKEN
 *   SLACK_CHANNEL_AI_ENGINEERING
 *   MINDBODY_EMAIL
 *   MINDBODY_PASSWORD
 */

const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const crypto = require('crypto');

// ─── Global Config ────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL     = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN           = process.env.DRY_RUN === 'true';
const FORCE_TASK        = process.env.TASK || 'auto'; // 'auto' | 'apartment' | 'gym' | 'all'

// ─── Shared Utilities ─────────────────────────────────────────────────────────

async function postToSlack(text) {
  if (DRY_RUN) {
    console.log('[DRY RUN] Slack message:');
    console.log(text);
    return;
  }
  try {
    const res = await axios.post(
      'https://slack.com/api/chat.postMessage',
      { channel: SLACK_CHANNEL, text },
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    if (!res.data.ok) console.warn('Slack warning:', res.data.error);
  } catch (err) {
    console.warn('Slack post failed:', err.message);
  }
}

function timeToMinutes(timeStr) {
  // "7:00 AM" → minutes since midnight
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!match) return -1;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const period = match[3].toUpperCase();
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return h * 60 + m;
}

function parseClassStartMinutes(classTimeStr) {
  const [start] = classTimeStr.trim().split(' - ');
  return timeToMinutes(start);
}

// ─── Task: Social Apartment Monitor ──────────────────────────────────────────

const APARTMENT_URL    = 'https://www.social-apartment.com/eng/builds/tokyo/koto-ku/view/49';
const APARTMENT_NAME   = 'World Neighbors Kiyosumi-Shirakawa';
const APARTMENT_STATE  = '/tmp/social-apartment-state.json';

function shouldRunApartmentMonitor(nowUtcHour) {
  return nowUtcHour % 4 === 0;
}

async function runApartmentMonitor() {
  console.log('\n' + '─'.repeat(60));
  console.log('TASK: Social Apartment Monitor');
  console.log(`Building: ${APARTMENT_NAME}`);
  console.log(`URL: ${APARTMENT_URL}`);
  console.log('─'.repeat(60));

  const lastState = loadApartmentState();
  if (lastState) {
    console.log(`Last state (${lastState.checkedAt}): hasAvailability=${lastState.analysis?.hasAvailability}, hash=${lastState.hash}`);
  } else {
    console.log('No previous state — first run.');
  }

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
  });
  const page = await context.newPage();

  let scraped;
  try {
    scraped = await scrapeApartment(page);
  } catch (err) {
    console.error('Apartment scrape failed:', err.message);
    await browser.close();

    if (lastState?.consecutiveFailures >= 2) {
      await postToSlack(`⚠️ *Marie — Apartment Monitor*\nFailed to scrape ${APARTMENT_NAME} — ${err.message}\nURL: ${APARTMENT_URL}`);
    }

    saveApartmentState({
      checkedAt: new Date().toISOString(),
      error: err.message,
      consecutiveFailures: (lastState?.consecutiveFailures || 0) + 1,
      analysis: lastState?.analysis || null,
      hash: lastState?.hash || null,
    });
    return;
  }

  await browser.close();

  const analysis = analyzeApartment(scraped);
  const hash = apartmentStateHash(analysis);

  console.log(`\n  Has availability: ${analysis.hasAvailability}`);
  console.log(`  Is full: ${analysis.isFull}`);
  console.log(`  Signals: ${analysis.signals.join(', ') || 'none'}`);
  console.log(`  Rooms found: ${analysis.roomsFound}`);
  console.log(`  State hash: ${hash}`);

  const stateChanged  = !lastState || lastState.hash !== hash;
  const newlyAvailable = analysis.hasAvailability && !lastState?.analysis?.hasAvailability;

  console.log(`  State changed: ${stateChanged}`);
  console.log(`  Newly available: ${newlyAvailable}`);

  if (newlyAvailable) {
    const roomDetails = analysis.rooms.length > 0
      ? '\n\n*Room details:*\n' + analysis.rooms.map(r => `• ${r.slice(0, 150)}`).join('\n')
      : '';
    await postToSlack([
      `🏠🚨 *ROOM AVAILABLE — ${APARTMENT_NAME}!*`,
      `A room has become available at the Tokyo Koto-ku Social Apartment.`,
      `*Availability signals:* ${analysis.signals.join(', ')}`,
      roomDetails,
      `\n👉 *Check it now:* ${APARTMENT_URL}`,
    ].join('\n'));

  } else if (stateChanged && analysis.hasAvailability) {
    await postToSlack([
      `🏠 *Social Apartment Update — ${APARTMENT_NAME}*`,
      `Room availability has changed.`,
      `*Current signals:* ${analysis.signals.join(', ') || 'none'}`,
      analysis.rooms.length > 0 ? '\n*Room excerpts:*\n' + analysis.rooms.map(r => `• ${r.slice(0, 150)}`).join('\n') : '',
      `\n👉 ${APARTMENT_URL}`,
    ].join('\n'));

  } else if (stateChanged && !analysis.hasAvailability) {
    await postToSlack([
      `🏠 *Social Apartment Update — ${APARTMENT_NAME}*`,
      `Availability has closed — no rooms currently showing as available.`,
      `👉 ${APARTMENT_URL}`,
    ].join('\n'));

  } else {
    console.log('No change in availability — no Slack notification.');
  }

  saveApartmentState({
    checkedAt: new Date().toISOString(),
    hash,
    analysis,
    consecutiveFailures: 0,
  });
}

async function scrapeApartment(page) {
  console.log(`Navigating to ${APARTMENT_URL}...`);
  await page.goto(APARTMENT_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/marie-apartment.png', fullPage: true });
  console.log('Screenshot saved to /tmp/marie-apartment.png');

  return await page.evaluate(() => {
    const results = [];

    const roomSelectors = [
      '.room-list li', '.room-item', '[class*="room-row"]',
      '[class*="roomList"] li', '[class*="room_list"] li',
      'table tr', '.plan-item', '[class*="plan-list"] li',
    ];
    let roomElements = [];
    for (const sel of roomSelectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) { roomElements = Array.from(els); break; }
    }

    if (roomElements.length === 0) {
      roomElements = Array.from(document.querySelectorAll('a, button, span, td, div')).filter(el => {
        const t = (el.innerText || el.textContent || '').trim();
        return t === 'Apply' || t === 'Enquire' || t === 'Available' || t === '空室' || t === '申込';
      });
    }

    roomElements.forEach(el => {
      let container = el;
      for (let i = 0; i < 4; i++) { if (container.parentElement) container = container.parentElement; }
      const text = (container.innerText || container.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && text.length > 5 && text.length < 500) results.push(text);
    });

    if (results.length === 0) {
      const allText = document.body.innerText || '';
      const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const roomKeywords = ['Apply', 'Available', 'Vacant', '空室', 'apply', 'available', 'Single', 'Double', 'Studio', '1K', '1R', 'Room'];
      results.push(...lines.filter(l => roomKeywords.some(k => l.includes(k))).slice(0, 30));
    }

    return {
      rooms: [...new Set(results)],
      pageTitle: document.title,
      fullText: (document.body.innerText || '').slice(0, 5000),
    };
  });
}

function analyzeApartment(scraped) {
  const { rooms, fullText, pageTitle } = scraped;

  const availabilitySignals = [
    { pattern: /apply/i,    label: 'Apply button present' },
    { pattern: /available/i, label: 'Available text found' },
    { pattern: /vacant/i,   label: 'Vacant text found' },
    { pattern: /空室/i,      label: 'Vacancy (空室) text found' },
    { pattern: /申込/i,      label: 'Application (申込) text found' },
  ];
  const signals = availabilitySignals.filter(s => s.pattern.test(fullText));
  const hasAvailability = signals.length > 0;

  const fullSignals = [/満室/i, /no vacancy/i, /no rooms available/i, /currently full/i, /waitlist/i];
  const isFull = fullSignals.some(p => p.test(fullText)) && !hasAvailability;

  return {
    hasAvailability,
    isFull,
    signals: signals.map(s => s.label),
    roomsFound: rooms.length,
    rooms: rooms.slice(0, 10),
    pageTitle,
  };
}

function apartmentStateHash(analysis) {
  const key = JSON.stringify({
    hasAvailability: analysis.hasAvailability,
    isFull: analysis.isFull,
    signals: analysis.signals.sort(),
    roomCount: analysis.roomsFound,
  });
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

function loadApartmentState() {
  if (fs.existsSync(APARTMENT_STATE)) {
    try { return JSON.parse(fs.readFileSync(APARTMENT_STATE, 'utf8')); } catch (e) {}
  }
  return null;
}

function saveApartmentState(state) {
  fs.writeFileSync(APARTMENT_STATE, JSON.stringify(state, null, 2));
  console.log('Apartment state saved.');
}

// ─── Task: Gym Class Booker ───────────────────────────────────────────────────

const GYM_STUDIO_ID   = '152065';
const GYM_STUDIO_NAME = 'One Playground, Marrickville';
const GYM_LOGIN_URL   = `https://clients.mindbodyonline.com/ASP/su1.asp?studioid=${GYM_STUDIO_ID}`;
const GYM_SCHEDULE_URL = `https://clients.mindbodyonline.com/ASP/main_enroll.asp?studioid=${GYM_STUDIO_ID}&tg=&vt=&lvl=&stype=-7&view=&trn=0&page=&catid=&prodid=&date=`;

const MINDBODY_EMAIL    = process.env.MINDBODY_EMAIL;
const MINDBODY_PASSWORD = process.env.MINDBODY_PASSWORD;

// Day-specific schedule (0=Sun, 1=Mon ... 6=Sat). null = rest day.
const GYM_DAY_SCHEDULE = {
  0: null,                                                       // Sunday — rest
  1: { classes: ['Beatbox'],            time: '07:00' },        // Monday
  2: { classes: ['Beatbox', "Pump'd"],  time: '07:00' },        // Tuesday
  3: null,                                                       // Wednesday — rest
  4: { classes: ['Beatbox', "Pump'd"],  time: '07:00' },        // Thursday
  5: { classes: ['Squad'],              time: '07:00' },        // Friday
  6: { classes: ['Blackout'],           time: '07:00' },        // Saturday
};

const GYM_TIME_TOLERANCE = 15; // ±minutes around target time

function shouldRunGymBooker(nowUtcHour) {
  return nowUtcHour === 11; // 11am UTC = 9pm AEST
}

function getTomorrowDateString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function getTomorrowLabel() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function isAtTargetTime(classTimeStr, targetTime) {
  const classMinutes = parseClassStartMinutes(classTimeStr);
  if (classMinutes < 0) return true;
  const [th, tm] = targetTime.split(':').map(Number);
  return Math.abs(classMinutes - (th * 60 + tm)) <= GYM_TIME_TOLERANCE;
}

function scoreGymClass(className, preferences) {
  const idx = preferences.findIndex(p => className.toLowerCase().includes(p.toLowerCase()));
  return idx === -1 ? preferences.length : idx;
}

async function runGymBooker() {
  console.log('\n' + '─'.repeat(60));
  console.log('TASK: Gym Class Booker');
  console.log(`Studio: ${GYM_STUDIO_NAME}`);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowDow = tomorrow.getDay();
  const schedule = GYM_DAY_SCHEDULE[tomorrowDow];

  console.log(`Booking for: ${getTomorrowLabel()} (day ${tomorrowDow})`);

  if (!schedule) {
    console.log('Rest day — nothing to book. 🛌');
    console.log('─'.repeat(60));
    return;
  }

  console.log(`Target: ${schedule.classes.join(' > ')} at ${schedule.time}`);
  console.log('─'.repeat(60));

  if (!MINDBODY_EMAIL || !MINDBODY_PASSWORD) {
    await postToSlack(`🏋️⚠️ *One Playground Booker*\nMINDBODY_EMAIL / MINDBODY_PASSWORD secrets not set.`);
    return;
  }

  const scheduleUrl = GYM_SCHEDULE_URL + getTomorrowDateString();

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'], headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
  });
  const page = await context.newPage();

  try {
    console.log(`\nNavigating to schedule: ${scheduleUrl}`);
    await page.goto(scheduleUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: '/tmp/marie-gym-schedule.png' });

    // Login if needed
    const needsLogin = await page.evaluate(() =>
      !!document.querySelector('#username, [name="username"], input[type="email"]')
    );
    if (needsLogin) {
      console.log('Logging in...');
      await gymLogin(page);
      await page.goto(scheduleUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
    } else {
      console.log('Already logged in ✓');
    }

    const classes = await extractGymClasses(page);
    console.log(`\nFound ${classes.length} class(es):`);
    classes.forEach((c, i) =>
      console.log(`  [${i + 1}] ${c.name} at ${c.time} — ${c.status} — score: ${scoreGymClass(c.name, schedule.classes)}`)
    );

    if (classes.length === 0) {
      await postToSlack(`🏋️ *One Playground — No classes found*\nNo classes for ${getTomorrowLabel()}.\n👉 ${scheduleUrl}`);
      await browser.close();
      return;
    }

    const available = classes
      .filter(c => c.bookable)
      .filter(c => isAtTargetTime(c.time, schedule.time))
      .sort((a, b) => scoreGymClass(a.name, schedule.classes) - scoreGymClass(b.name, schedule.classes));

    console.log(`\nBookable at ${schedule.time}: ${available.length}`);

    if (available.length === 0) {
      const alreadyBooked = classes.find(c =>
        c.status?.toLowerCase().includes('booked') || c.status?.toLowerCase().includes('enrolled')
      );
      if (alreadyBooked) {
        await postToSlack(`🏋️ *One Playground — Already Booked*\n✅ ${alreadyBooked.name} on ${getTomorrowLabel()} at ${alreadyBooked.time}`);
      } else {
        await postToSlack([
          `🏋️ *One Playground — No Bookable Classes*`,
          `Looking for: *${schedule.classes.join(' / ')}* at ${schedule.time} on ${getTomorrowLabel()} — none available.`,
          `All classes: ${classes.map(c => `${c.name} ${c.time} (${c.status})`).join(', ') || 'none'}`,
          `👉 ${scheduleUrl}`,
        ].join('\n'));
      }
      await browser.close();
      return;
    }

    const target = available[0];
    console.log(`\nTarget: ${target.name} at ${target.time}`);

    if (DRY_RUN) {
      await postToSlack(`🏋️ *[DRY RUN] One Playground*\nWould book: *${target.name}* on ${getTomorrowLabel()} at ${target.time}\n_Preferences: ${schedule.classes.join(' > ')}_`);
      await browser.close();
      return;
    }

    await page.screenshot({ path: '/tmp/marie-gym-before.png' });
    const booked = await bookGymClass(page, target);
    await page.screenshot({ path: '/tmp/marie-gym-after.png' });

    if (booked.success) {
      await postToSlack([
        `🏋️✅ *One Playground — Booked!*`,
        `*${target.name}*`,
        `📅 ${getTomorrowLabel()} at ${target.time}`,
        `📍 ${GYM_STUDIO_NAME}`,
        `_Cancel 10+ hours before if you can't make it (avoid the $5 late cancel fee)._`,
      ].join('\n'));
    } else {
      await postToSlack([
        `🏋️❌ *One Playground — Booking Failed*`,
        `Tried: *${target.name}* at ${target.time} on ${getTomorrowLabel()}`,
        `Error: ${booked.error}`,
        `👉 Book manually: ${scheduleUrl}`,
      ].join('\n'));
    }

  } catch (err) {
    console.error('Gym booker error:', err.message);
    await page.screenshot({ path: '/tmp/marie-gym-error.png' }).catch(() => {});
    await postToSlack(`🏋️⚠️ *One Playground Booker — Error*\n${err.message}\nPlease book manually.`);
  }

  await browser.close();
}

async function gymLogin(page) {
  await page.waitForSelector('input[name="username"], input[type="email"], #username', { timeout: 10000 });
  await page.locator('input[name="username"], input[type="email"], #username').first().fill(MINDBODY_EMAIL);
  await page.locator('input[name="password"], input[type="password"], #password').first().fill(MINDBODY_PASSWORD);
  await page.locator('button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In")').first().click();
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 });
  console.log('Login submitted ✓');
}

async function extractGymClasses(page) {
  return await page.evaluate(() => {
    const classes = [];

    const rows = document.querySelectorAll('tr.classRow, tr[class*="class"], .class-row, [data-classid]');
    rows.forEach(row => {
      const name = (row.querySelector('.className, .class-name, [class*="className"], td:first-child a')?.innerText || '').trim();
      const time = (row.querySelector('.classTime, .class-time, [class*="classTime"], td:nth-child(2)')?.innerText || '').trim();
      const statusEl = row.querySelector('.enrollLink, .enroll-link, [class*="enroll"], a[href*="enroll"], button');
      const statusText = (statusEl?.innerText || '').trim();
      if (name && time) {
        classes.push({
          name, time,
          status: statusText || 'unknown',
          bookable: /enroll|book|sign up|add/i.test(statusText),
          enrollHref: statusEl?.href || '',
          rowId: row.id || row.getAttribute('data-classid') || '',
        });
      }
    });

    if (classes.length === 0) {
      document.querySelectorAll('[class*="class-card"], [class*="classCard"], [class*="session"], .bw-widget__class').forEach(card => {
        const name = (card.querySelector('[class*="name"], [class*="title"]')?.innerText || '').trim();
        const time = (card.querySelector('[class*="time"], [class*="start"]')?.innerText || '').trim();
        const btn = card.querySelector('button, a');
        const statusText = (btn?.innerText || '').trim();
        if (name) classes.push({
          name, time,
          status: statusText,
          bookable: /book|sign|enroll/i.test(statusText),
          enrollHref: btn?.href || '',
          rowId: card.getAttribute('data-class-id') || '',
        });
      });
    }

    return classes;
  });
}

async function bookGymClass(page, classInfo) {
  try {
    const enrolled = await page.evaluate((cls) => {
      for (const row of document.querySelectorAll('tr.classRow, tr[class*="class"], [data-classid]')) {
        const name = (row.querySelector('.className, .class-name, td:first-child a')?.innerText || '').trim();
        if (name.toLowerCase().includes(cls.name.toLowerCase().slice(0, 10))) {
          const btn = row.querySelector('a[href*="enroll"], button:has-text("Enroll"), button:has-text("Book"), a:has-text("Sign Up")');
          if (btn) { btn.click(); return { clicked: true, href: btn.href }; }
        }
      }
      return { clicked: false };
    }, classInfo);

    if (!enrolled.clicked) {
      if (classInfo.enrollHref?.startsWith('http')) {
        await page.goto(classInfo.enrollHref, { waitUntil: 'networkidle', timeout: 30000 });
      } else {
        throw new Error('Could not find enroll button');
      }
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    }

    await page.waitForTimeout(2000);
    const pageText = await page.evaluate(() => document.body.innerText);
    const confirmed = /confirmed|reservation|enrolled|booked|success/i.test(pageText);
    const hasError  = /error|failed|unable|full/i.test(pageText);

    if (confirmed && !hasError) return { success: true };
    if (hasError) {
      const m = pageText.match(/error[:\s]+([^\n]+)/i);
      return { success: false, error: m?.[1] || 'Booking error — check screenshot' };
    }
    return { success: false, error: 'Unclear result — check screenshot' };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

async function main() {
  const now = new Date();
  const nowUtcHour = now.getUTCHours();

  console.log('='.repeat(60));
  console.log('Marie — Orchestrator');
  console.log(`Time (UTC): ${now.toISOString()}`);
  console.log(`UTC hour: ${nowUtcHour}`);
  console.log(`Force task: ${FORCE_TASK}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('='.repeat(60));

  const runApartment = FORCE_TASK === 'all' || FORCE_TASK === 'apartment'
    || (FORCE_TASK === 'auto' && shouldRunApartmentMonitor(nowUtcHour));

  const runGym = FORCE_TASK === 'all' || FORCE_TASK === 'gym'
    || (FORCE_TASK === 'auto' && shouldRunGymBooker(nowUtcHour));

  console.log(`\nTasks this run:`);
  console.log(`  Apartment Monitor: ${runApartment ? '✅ running' : '⏭ skipped'}`);
  console.log(`  Gym Booker:        ${runGym ? '✅ running' : '⏭ skipped'}`);

  if (!runApartment && !runGym) {
    console.log('\nNothing scheduled this hour. Exiting.');
    return;
  }

  // Run tasks sequentially, isolated
  if (runApartment) {
    try {
      await runApartmentMonitor();
    } catch (err) {
      console.error('Apartment monitor crashed:', err.message);
      await postToSlack(`⚠️ *Marie — Apartment Monitor crashed*\n${err.message}`).catch(() => {});
    }
  }

  if (runGym) {
    try {
      await runGymBooker();
    } catch (err) {
      console.error('Gym booker crashed:', err.message);
      await postToSlack(`⚠️ *Marie — Gym Booker crashed*\n${err.message}`).catch(() => {});
    }
  }

  console.log('\n✅ Marie done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
