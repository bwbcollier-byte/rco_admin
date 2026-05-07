/**
 * DJ Patil — Weekly Data Quality Brief
 *
 * Runs every Thursday 7am AEST via GitHub Actions.
 * 1. Queries Supabase for HypeBase coverage/freshness and Fitspire retention signals
 * 2. Calls Claude (Haiku) with Patil's system prompt to generate the brief
 * 3. Posts to Slack #ai-engineering
 * 4. Logs run to Airtable Run Log
 *
 * NOTE: Table names (hb_talent vs hb_artists, fs_events, fs_users) need verification.
 * See SETUP-NOTES.md for confirmation SQL.
 *
 * Required secrets: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *                   AIRTABLE_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING
 */

const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Airtable = require('airtable');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const RUN_LOG = airtable.base('app6biS7yjV6XzFVG')('tblMahtVoLVT92NWJ');
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN = process.env.DRY_RUN === 'true';
const today = new Date().toISOString().split('T')[0];

async function getHypeBaseQuality() {
  try {
    const now = new Date();
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // Use server-side counts — avoids fetching all 1.6M rows
    const { count: total, error: totalError } = await supabase
      .from('hb_talent').select('*', { count: 'exact', head: true });
    if (totalError) throw totalError;

    const { count: freshLast30d, error: freshError } = await supabase
      .from('hb_talent').select('*', { count: 'exact', head: true })
      .gte('updated_at', thirtyDaysAgo.toISOString());
    if (freshError) throw freshError;

    const { count: updatedThisWeek, error: weekError } = await supabase
      .from('hb_talent').select('*', { count: 'exact', head: true })
      .gte('updated_at', oneWeekAgo.toISOString());
    if (weekError) throw weekError;

    // soc_spotify is the correct column name (not spotify_id)
    const { count: hasSpotify, error: spotifyError } = await supabase
      .from('hb_talent').select('*', { count: 'exact', head: true })
      .not('soc_spotify', 'is', null);
    if (spotifyError) throw spotifyError;

    return {
      total,
      freshLast30d,
      freshnessPct: total > 0 ? Math.round(freshLast30d / total * 100 * 10) / 10 : 0,
      updatedThisWeek,
      hasSpotify,
      spotifyCoveragePct: total > 0 ? Math.round(hasSpotify / total * 100 * 10) / 10 : 0,
      error: null
    };
  } catch (err) {
    console.warn('⚠️  HypeBase quality error:', err.message);
    return { error: err.message };
  }
}

async function getFitspireSignals() {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // fs_events is a store/marketing events table — user analytics not yet instrumented
    // DAU/MAU unavailable until user activity tracking is added
    const dau = null;
    const mau = null;
    const stickyFactor = null;

    const { count: newUsers } = await supabase
      .from('fs_profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', oneWeekAgo.toISOString());

    return { dau, mau, stickyFactor, newUsers: newUsers || 0, error: null };
  } catch (err) {
    console.warn('⚠️  Fitspire signals error:', err.message);
    return { error: err.message };
  }
}

async function generateBrief(hypebase, fitspire) {
  const hbSection = hypebase.error
    ? `Error: ${hypebase.error}`
    : `- Total talent records: ${hypebase.total?.toLocaleString()}
- Updated this week: ${hypebase.updatedThisWeek?.toLocaleString()} records
- Fresh last 30 days: ${hypebase.freshLast30d?.toLocaleString()} (${hypebase.freshnessPct}%)
- Spotify ID coverage: ${hypebase.hasSpotify?.toLocaleString()} (${hypebase.spotifyCoveragePct}%)`;

  const fsSection = fitspire.error
    ? `Error: ${fitspire.error}`
    : `- DAU: ${fitspire.dau?.toLocaleString()} | MAU: ${fitspire.mau?.toLocaleString()} | Sticky: ${fitspire.stickyFactor}%
- New users this week: ${fitspire.newUsers?.toLocaleString()}`;

  const prompt = `Produce the weekly data quality brief for Rascals Inc. Date: ${today}.

HYPEBASE DATA QUALITY:
${hbSection}

FITSPIRE BEHAVIOUR SIGNALS:
${fsSection}

Format:

## 📋 Data Quality Brief — ${today}

### HypeBase Coverage Health
[Interpret the numbers — what's healthy, what's a concern]

### Fitspire Behaviour Signals
[Interpret DAU/MAU/sticky — what does this tell us about engagement?]

### The Data Gap
[The single most important data gap hurting decision-making right now]

### One Data Action This Week
[Specific. Named table or field. Estimated effort.]

Under 250 words. Numbers only — no approximations. If data errored, flag plainly.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are DJ Patil, former US Chief Data Scientist. You start with the question that changes a decision. You care about data coverage, freshness, and quality as first-class metrics. You are direct and do not pad reports. If data is missing, you flag it as a gap and specify what query would fill it.`,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

async function postToSlack(brief) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', brief); return; }
  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: brief, username: 'DJ Patil', icon_emoji: ':bar_chart:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  if (!response.data.ok) throw new Error(`Slack error: ${response.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: {
    'Run ID': `Patil — Weekly Data Quality Brief — ${today}`,
    Status: status, Date: today,
    Summary: notes.substring(0, 500),
    'Workflow File': 'patil-weekly-data-quality.yml'
  }}]);
}

async function main() {
  console.log(`📋 DJ Patil — Weekly Data Quality Brief — ${today}`);
  if (DRY_RUN) console.log('🔵 DRY RUN mode active');
  try {
    const [hypebase, fitspire] = await Promise.all([getHypeBaseQuality(), getFitspireSignals()]);
    const brief = await generateBrief(hypebase, fitspire);
    await postToSlack(brief);
    await logToRunLog('✅ Success', 'Data quality brief posted to #ai-engineering');
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}

main();
