/**
 * Brian Balfour — Weekly Growth Brief
 * Runs Friday 7am AEST. Pulls Fitspire metrics from Supabase + HypeBase scraper
 * health from Airtable Run Log, generates growth-focused analysis via Claude Haiku,
 * posts to Slack #growth-marketing.
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
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_GROWTH_MARKETING;
const DRY_RUN = process.env.DRY_RUN === 'true';
const today = new Date().toISOString().split('T')[0];

async function getFitspireGrowthData() {
  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const oneWeekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const [{ data: dauData }, { data: mauData }, { count: newUsers }] = await Promise.all([
      supabase.from('fs_events').select('user_id').gte('created_at', todayStart.toISOString()),
      supabase.from('fs_events').select('user_id').gte('created_at', thirtyDaysAgo.toISOString()),
      supabase.from('fs_profiles').select('*', { count: 'exact', head: true }).gte('created_at', oneWeekAgo.toISOString())
    ]);

    const dau = new Set((dauData || []).map(r => r.user_id)).size;
    const mau = new Set((mauData || []).map(r => r.user_id)).size;
    return { dau, mau, stickyFactor: mau > 0 ? Math.round(dau / mau * 100 * 10) / 10 : 0, newUsers: newUsers || 0, error: null };
  } catch (err) {
    return { error: err.message };
  }
}

async function generateBrief(data) {
  const fsSection = data.fitspire.error
    ? `Error: ${data.fitspire.error}`
    : `DAU: ${data.fitspire.dau} | MAU: ${data.fitspire.mau} | Sticky: ${data.fitspire.stickyFactor}% | New users this week: ${data.fitspire.newUsers}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are Brian Balfour, VP Growth at HubSpot, founder of Reforge. You apply the Four Fits framework. You identify the growth constraint — not symptoms, but root cause. You recommend one experiment per week, never more. You are direct.`,
    messages: [{ role: 'user', content: `Weekly growth brief for Rascals Inc. Date: ${today}.

FITSPIRE METRICS:
${fsSection}

HYPEBASE: Pre-traction. No users yet. Growth constraint is ICP definition and initial distribution.

Format:
## 📈 Growth Brief — ${today}

### Retention Signal (Fitspire)
[Interpret sticky factor and new user trend]

### Acquisition Signal
[What channels are driving new users? If unknown, flag as measurement gap]

### The Growth Constraint This Week
[One specific bottleneck — not "we need more users" — name the exact lever]

### One Experiment
[Hypothesis + metric + decision rule. Concrete.]

Under 200 words.` }]
  });
  return response.content[0].text;
}

async function postToSlack(brief) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', brief); return; }
  const res = await axios.post('https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: brief, username: 'Brian Balfour', icon_emoji: ':chart_with_upwards_trend:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: { 'Run ID': `Balfour — Weekly Growth Brief — ${today}`, Status: status, Date: today, Summary: notes.substring(0, 500), 'Workflow File': 'balfour-weekly-growth.yml' } }]);
}

async function main() {
  console.log(`📈 Brian Balfour — Weekly Growth Brief — ${today}`);
  try {
    const fitspire = await getFitspireGrowthData();
    const brief = await generateBrief({ fitspire });
    await postToSlack(brief);
    await logToRunLog('✅ Success', 'Weekly growth brief posted to #growth-marketing');
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}
main();
