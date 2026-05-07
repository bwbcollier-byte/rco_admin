/**
 * Avinash Kaushik — Weekly KPI Report
 *
 * Runs every Monday 7am AEST via GitHub Actions.
 * 1. Queries Supabase for HypeBase and Fitspire stats
 * 2. Calls Claude (Haiku) with Kaushik's system prompt to generate narrative
 * 3. Posts to Slack #ai-engineering
 * 4. Logs run to Airtable Run Log
 *
 * Required secrets in rco_admin:
 *   ANTHROPIC_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN
 *   SLACK_CHANNEL_AI_ENGINEERING  (channel ID, not name — e.g. C0123456789)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Airtable = require('airtable');
const axios = require('axios');

// ── Config ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const RI_DEVELOPER = airtable.base('app6biS7yjV6XzFVG');
const RUN_LOG = RI_DEVELOPER('tblMahtVoLVT92NWJ');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN = process.env.DRY_RUN === 'true';

const today = new Date().toISOString().split('T')[0];

// ── Data Collection ─────────────────────────────────────────────────────────

async function getHypeBaseStats() {
  try {
    // Total artist count and freshness
    // NOTE: Verify table name — may be hb_talent, hb_profiles, or similar
    const { data: overview, error: overviewError } = await supabase
      .from('hb_talent')
      .select('updated_at', { count: 'exact' });

    if (overviewError) throw overviewError;

    const totalArtists = overview.length;
    const now = new Date();
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

    const updatedThisWeek = overview.filter(r => new Date(r.updated_at) > oneWeekAgo).length;
    const updatedToday = overview.filter(r => new Date(r.updated_at) > oneDayAgo).length;
    const weeklyFreshnessPct = totalArtists > 0
      ? Math.round(updatedThisWeek / totalArtists * 100 * 10) / 10
      : 0;

    // Scraper run success rate from Airtable Run Log this week
    const runLogRecords = await RUN_LOG.select({
      filterByFormula: `AND(
        IS_AFTER({Date}, DATEADD(TODAY(), -7, 'days')),
        FIND('yl-hb', {Repo})
      )`,
      fields: ['Run ID', 'Status', 'Repo']
    }).firstPage();

    const totalRuns = runLogRecords.length;
    const successRuns = runLogRecords.filter(r =>
      (r.get('Status') || '').includes('✅') || (r.get('Status') || '').toLowerCase().includes('success')
    ).length;
    const scraperSuccessRate = totalRuns > 0
      ? Math.round(successRuns / totalRuns * 100)
      : null;

    return {
      totalArtists,
      updatedThisWeek,
      updatedToday,
      weeklyFreshnessPct,
      scraperSuccessRate,
      scraperRunsTotal: totalRuns,
      error: null
    };
  } catch (err) {
    console.warn('⚠️  HypeBase stats error:', err.message);
    return { error: err.message };
  }
}

async function getFitspireStats() {
  try {
    // NOTE: Verify table names — may differ from fs_events / fs_users
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

    // DAU — distinct users with an event today
    const { data: dauData, error: dauError } = await supabase
      .from('fs_events')
      .select('user_id')
      .gte('created_at', todayStart.toISOString());
    if (dauError) throw dauError;

    const dau = new Set(dauData.map(r => r.user_id)).size;

    // MAU — distinct users last 30 days
    const { data: mauData, error: mauError } = await supabase
      .from('fs_events')
      .select('user_id')
      .gte('created_at', thirtyDaysAgo.toISOString());
    if (mauError) throw mauError;

    const mau = new Set(mauData.map(r => r.user_id)).size;
    const stickyFactor = mau > 0 ? Math.round(dau / mau * 100 * 10) / 10 : 0;

    // New sign-ups this week
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const { count: newInstalls, error: installError } = await supabase
      .from('fs_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', oneWeekAgo.toISOString());
    if (installError) throw installError;

    return { dau, mau, stickyFactor, newInstalls: newInstalls || 0, error: null };
  } catch (err) {
    console.warn('⚠️  Fitspire stats error:', err.message);
    return { error: err.message };
  }
}

// ── Report Generation ───────────────────────────────────────────────────────

async function generateReport(hypebase, fitspire) {
  const dataSection = `
HYPEBASE DATA:
${hypebase.error
  ? `Error collecting: ${hypebase.error}`
  : `- Total artists in database: ${hypebase.totalArtists?.toLocaleString() ?? 'unknown'}
- Updated this week: ${hypebase.updatedThisWeek?.toLocaleString() ?? 'unknown'} (${hypebase.weeklyFreshnessPct ?? '?'}% fresh)
- Updated today: ${hypebase.updatedToday?.toLocaleString() ?? 'unknown'}
- Scraper success rate this week: ${hypebase.scraperSuccessRate != null ? `${hypebase.scraperSuccessRate}%` : 'unknown'} (${hypebase.scraperRunsTotal ?? 0} runs)`
}

FITSPIRE DATA:
${fitspire.error
  ? `Error collecting: ${fitspire.error}`
  : `- DAU: ${fitspire.dau?.toLocaleString() ?? 'unknown'}
- MAU: ${fitspire.mau?.toLocaleString() ?? 'unknown'}
- Sticky factor (DAU/MAU): ${fitspire.stickyFactor ?? '?'}%
- New installs this week: ${fitspire.newInstalls?.toLocaleString() ?? 'unknown'}`
}

PROMPTKIT DATA: Not yet instrumented — pending analytics implementation.
SOCIAL STATS: Manual collection pending — no API access configured yet.
PAID MEDIA: Not yet active.
`.trim();

  const prompt = `Generate a weekly KPI snapshot for Rascals Inc for the week ending ${today}.

${dataSection}

Format exactly as follows (use actual numbers, not placeholders):

## 📊 Weekly KPI Snapshot — ${today}

### HypeBase — Data Platform
[key metrics with any available context on trend]

### Fitspire — Fitness App
[key metrics with sticky factor interpretation]

### PromptKit & Paid Media
[brief note on instrumentation status]

### The Signal
[2 sentences maximum — the single most important thing the numbers are telling us this week. Be direct.]

### One Thing to Act On
[One specific, actionable recommendation. Name the owner. Give a clear action.]

### Measurement Gaps
[Brief bullet list of what we couldn't measure and should fix]

Keep the total response under 400 words. No filler. No hedging.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: `You are Avinash Kaushik, digital marketing evangelist and analytics expert. You are direct, data-obsessed, and deeply intolerant of vanity metrics. You close every analysis with a clear "One Thing to Act On." You use real numbers, not placeholders. If data is missing, say so plainly and flag it as a gap. Never make up numbers.`,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// ── Output ──────────────────────────────────────────────────────────────────

async function postToSlack(report) {
  if (DRY_RUN) {
    console.log('🔵 DRY RUN — Slack post skipped. Report:\n');
    console.log(report);
    return;
  }

  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel: SLACK_CHANNEL,
      text: report,
      username: 'Avinash Kaushik',
      icon_emoji: ':bar_chart:'
    },
    {
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.data.ok) {
    throw new Error(`Slack error: ${response.data.error}`);
  }
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{
    fields: {
      'Run ID': `Kaushik — Weekly KPI Report — ${today}`,
      Status: status,
      Date: today,
      Summary: notes.substring(0, 500),
      'Workflow File': 'kaushik-weekly-kpi-report.yml'
    }
  }]);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`📊 Avinash Kaushik — Weekly KPI Report — ${today}`);
  if (DRY_RUN) console.log('🔵 DRY RUN mode active');

  try {
    console.log('⏳ Collecting data...');
    const [hypebase, fitspire] = await Promise.all([
      getHypeBaseStats(),
      getFitspireStats()
    ]);

    console.log('HypeBase:', JSON.stringify(hypebase, null, 2));
    console.log('Fitspire:', JSON.stringify(fitspire, null, 2));

    console.log('⏳ Generating Kaushik report...');
    const report = await generateReport(hypebase, fitspire);

    console.log('⏳ Posting to Slack...');
    await postToSlack(report);

    await logToRunLog('✅ Success', 'Weekly KPI report generated and posted to #ai-engineering');
    console.log('✅ Done.');

  } catch (err) {
    console.error('❌ Error:', err.message);
    try {
      await logToRunLog('❌ Failed', err.message);
    } catch (logErr) {
      console.error('❌ Also failed to log to Airtable:', logErr.message);
    }
    process.exit(1);
  }
}

main();
