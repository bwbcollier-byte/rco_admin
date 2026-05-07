/**
 * Monthly All-Staff Synthesis
 * Runs first Wednesday of each month, 7:00am AEST.
 * Reads last 30 days of Run Log from Airtable (all Tier 1 staff runs).
 * Generates cross-staff synthesis via Claude Haiku.
 * Posts to #ai-engineering.
 */

const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const RUN_LOG = airtable.base('app6biS7yjV6XzFVG')('tblMahtVoLVT92NWJ');
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN = process.env.DRY_RUN === 'true';
const today = new Date().toISOString().split('T')[0];

// Only run on first Wednesday of the month
function isFirstWednesdayOfMonth() {
  const now = new Date();
  return now.getDate() <= 7;
}

// Get date 30 days ago
function thirtyDaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

async function fetchRunLogEntries() {
  const cutoff = thirtyDaysAgo();
  const records = [];

  await new Promise((resolve, reject) => {
    RUN_LOG.select({
      filterByFormula: `{Date} >= '${cutoff}'`,
      fields: ['Run ID', 'Status', 'Date', 'Summary', 'Workflow File'],
      sort: [{ field: 'Date', direction: 'desc' }],
      maxRecords: 200
    }).eachPage(
      (page, next) => { records.push(...page.map(r => r.fields)); next(); },
      (err) => { if (err) reject(err); else resolve(); }
    );
  });

  return records;
}

function summariseRunLog(records) {
  if (records.length === 0) return 'No automated runs recorded in the last 30 days.';

  // Group by staff name
  const byStaff = {};
  for (const r of records) {
    // Extract staff name from Run ID (format: "StaffName — Task — date")
    const runId = r['Run ID'] || 'Unknown';
    const name = runId.split(' — ')[0] || runId;
    if (!byStaff[name]) byStaff[name] = { success: 0, failed: 0, notes: [] };
    if ((r['Status'] || '').includes('✅')) byStaff[name].success++;
    else byStaff[name].failed++;
    if (r['Summary']) byStaff[name].notes.push(r['Summary'].substring(0, 100));
  }

  const lines = [];
  for (const [name, data] of Object.entries(byStaff)) {
    const rate = data.success + data.failed > 0
      ? Math.round((data.success / (data.success + data.failed)) * 100)
      : 0;
    lines.push(`${name}: ${data.success} success / ${data.failed} failed (${rate}% uptime)`);
  }

  return lines.join('\n');
}

async function generateSynthesis(runLogSummary, recordCount) {
  const monthName = new Date().toLocaleString('en-AU', { month: 'long', year: 'numeric' });

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: `You are the AI Staff Chief of Staff for Rascals Inc. You synthesise the monthly output of all automated AI staff members into a single strategic brief for Ben (CEO, solo founder). You apply Andy Grove's limiting step thinking: identify the one most important constraint the combined picture reveals. You are concise and direct.`,
    messages: [{ role: 'user', content: `Monthly all-staff synthesis for ${monthName}.

AUTOMATED STAFF RUN LOG (last 30 days):
${runLogSummary}

Total runs logged: ${recordCount}

Generate the monthly synthesis in this format:

## 🤖 Monthly All-Staff Synthesis — ${monthName}

### Automation Health
[2-3 sentences: overall uptime, any workflows that need attention, any new failures]

### Cross-Staff Patterns
[What does the combined picture across engineering, growth, and ops reveal? 2-3 observations that span multiple staff areas — not just per-staff summaries]

### The Limiting Step This Month
[Apply Andy Grove: given everything the staff saw this month, what is the single constraint that is blocking the most progress? Name it specifically.]

### Recommended Actions for Next Month
1. [action — which staff to engage — why now]
2. [action — which staff to engage — why now]
3. [action — which staff to engage — why now]

### Briefs Running Well (No Action Needed)
[list staff whose automated briefs ran cleanly and whose domain is healthy]

Under 300 words total.` }]
  });

  return response.content[0].text;
}

async function postToSlack(synthesis) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', synthesis); return; }
  const res = await axios.post('https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: synthesis, username: 'AI Staff — Monthly Synthesis', icon_emoji: ':busts_in_silhouette:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: { 'Run ID': `Monthly All-Staff Synthesis — ${today}`, Status: status, Date: today, Summary: notes.substring(0, 500), 'Workflow File': 'monthly-synthesis.yml' } }]);
}

async function main() {
  console.log(`🤖 Monthly All-Staff Synthesis — ${today}`);

  if (!isFirstWednesdayOfMonth()) {
    console.log('Not first Wednesday of month — skipping.');
    return;
  }

  try {
    console.log('Fetching Run Log entries (last 30 days)...');
    const records = await fetchRunLogEntries();
    console.log(`Found ${records.length} run log entries.`);

    const runLogSummary = summariseRunLog(records);
    console.log('Run log summary:\n', runLogSummary);

    const synthesis = await generateSynthesis(runLogSummary, records.length);
    await postToSlack(synthesis);
    await logToRunLog('✅ Success', `Monthly synthesis posted — ${records.length} run log entries analysed`);
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}
main();
