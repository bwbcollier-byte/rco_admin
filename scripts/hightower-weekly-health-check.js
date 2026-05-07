/**
 * Kelsey Hightower — Weekly Infrastructure Health Check
 *
 * Runs every Monday 7:30am AEST via GitHub Actions.
 * 1. Queries Airtable Run Log for last 7 days of workflow executions
 * 2. Calculates per-repo success rates and assigns 🟢/🟡/🔴 status
 * 3. Calls Claude (Haiku) with Hightower's system prompt to generate narrative
 * 4. Posts to Slack #ai-engineering
 * 5. Logs run to Airtable Run Log
 *
 * Required secrets in rco_admin:
 *   ANTHROPIC_API_KEY
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN
 *   SLACK_CHANNEL_AI_ENGINEERING  (channel ID, not name — e.g. C0123456789)
 */

const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const axios = require('axios');

// ── Config ─────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const RI_DEVELOPER = airtable.base('app6biS7yjV6XzFVG');
const RUN_LOG = RI_DEVELOPER('tblMahtVoLVT92NWJ');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN = process.env.DRY_RUN === 'true';

const today = new Date().toISOString().split('T')[0];

// ── Status helpers ──────────────────────────────────────────────────────────
function isSuccess(record) {
  const status = (record.get('Status') || '').toLowerCase();
  return status.includes('✅') || status === 'success' || status.includes('success');
}

function rateToEmoji(rate, total) {
  if (total === 0) return '⚪'; // no runs
  if (rate >= 95) return '🟢';
  if (rate >= 75) return '🟡';
  return '🔴';
}

// ── Data Collection ─────────────────────────────────────────────────────────
async function getRunLogData() {
  try {
    const records = await RUN_LOG.select({
      filterByFormula: `IS_AFTER({Date}, DATEADD(TODAY(), -7, 'days'))`,
      fields: ['Run ID', 'Status', 'Date', 'Repo', 'Summary', 'Workflow File']
    }).all();

    // Group by repo
    const byRepo = {};
    for (const r of records) {
      const repo = (r.get('Repo') || 'unknown').trim();
      if (!byRepo[repo]) byRepo[repo] = { runs: 0, success: 0, failures: [] };
      byRepo[repo].runs++;
      if (isSuccess(r)) {
        byRepo[repo].success++;
      } else {
        byRepo[repo].failures.push({
          name: r.get('Run ID') || '',
          date: r.get('Date') || '',
          notes: (r.get('Summary') || '').substring(0, 200)
        });
      }
    }

    // Calculate rates and statuses
    const repoStats = Object.entries(byRepo).map(([repo, data]) => {
      const rate = data.runs > 0 ? Math.round(data.success / data.runs * 100) : 0;
      return {
        repo,
        runs: data.runs,
        success: data.success,
        fail: data.runs - data.success,
        rate,
        emoji: rateToEmoji(rate, data.runs),
        recentFailure: data.failures[0] || null
      };
    }).sort((a, b) => {
      // Sort: red first, then yellow, then green, then no-run
      const order = { '🔴': 0, '🟡': 1, '🟢': 2, '⚪': 3 };
      return (order[a.emoji] ?? 4) - (order[b.emoji] ?? 4);
    });

    // Separate scraper repos from rco_admin workflows
    const scraperRepos = repoStats.filter(r => r.repo.includes('yl-hb'));
    const otherRepos = repoStats.filter(r => !r.repo.includes('yl-hb'));

    const totalRuns = records.length;
    const totalSuccess = records.filter(isSuccess).length;
    const overallRate = totalRuns > 0 ? Math.round(totalSuccess / totalRuns * 100) : 0;

    return { scraperRepos, otherRepos, overallRate, totalRuns, totalSuccess, error: null };
  } catch (err) {
    console.warn('⚠️  Run Log query error:', err.message);
    return { error: err.message };
  }
}

// ── Report Generation ───────────────────────────────────────────────────────
async function generateReport(data) {
  let scraperTable = '';
  if (data.scraperRepos && data.scraperRepos.length > 0) {
    scraperTable = data.scraperRepos.map(r =>
      `- ${r.emoji} ${r.repo}: ${r.runs} runs, ${r.rate}% success (${r.fail} failed)`
    ).join('\n');
  } else {
    scraperTable = 'No scraper runs recorded this week.';
  }

  let otherWorkflows = '';
  if (data.otherRepos && data.otherRepos.length > 0) {
    otherWorkflows = data.otherRepos.map(r =>
      `- ${r.emoji} ${r.repo}: ${r.runs} runs, ${r.rate}% success`
    ).join('\n');
  } else {
    otherWorkflows = 'No other workflow runs recorded this week.';
  }

  const dataSection = data.error
    ? `Error collecting Run Log data: ${data.error}`
    : `OVERALL: ${data.totalRuns} total runs this week, ${data.overallRate}% overall success rate

SCRAPER FLEET (yl-hb-*):
${scraperTable}

OTHER WORKFLOWS (rco_admin and non-scraper):
${otherWorkflows}`;

  const prompt = `Generate a weekly infrastructure health report for Rascals Inc for the week ending ${today}.

${dataSection}

Format exactly as follows:

## 🛠️ Infrastructure Health — ${today}

### Scraper Fleet
[Paste the scraper table from the data, add emoji status per repo]

### rco_admin Workflows
[Status of non-scraper workflows]

### Active Issues
[Numbered list of repos with failures — root cause if inferrable from notes, otherwise "cause unknown — investigate"]

### One Fix This Week
[The single highest-leverage infrastructure fix. Specific repo. Specific action. Time estimate.]

### Credential Expiry Risk
[Flag any repos that have been failing with auth/cookie/token patterns]

Keep under 350 words. Direct. No hedging. If data is sparse, say so plainly.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    system: `You are Kelsey Hightower, infrastructure engineer and reliability advocate. You value simplicity and observability. You are direct and prescriptive — you give one clear recommendation, not a list of options. You call out credential failures and silent failure patterns explicitly. You do not pad reports with filler.`,
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
      username: 'Kelsey Hightower',
      icon_emoji: ':wrench:'
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
      'Run ID': `Hightower — Weekly Infrastructure Health Check — ${today}`,
      Status: status,
      Date: today,
      Summary: notes.substring(0, 500),
      'Workflow File': 'hightower-weekly-health-check.yml'
    }
  }]);
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🛠️  Kelsey Hightower — Weekly Health Check — ${today}`);
  if (DRY_RUN) console.log('🔵 DRY RUN mode active');

  try {
    console.log('⏳ Querying Run Log...');
    const data = await getRunLogData();

    console.log('Run Log summary:', JSON.stringify({
      totalRuns: data.totalRuns,
      overallRate: data.overallRate,
      scraperCount: data.scraperRepos?.length,
      redCount: data.scraperRepos?.filter(r => r.emoji === '🔴').length
    }, null, 2));

    console.log('⏳ Generating Hightower report...');
    const report = await generateReport(data);

    console.log('⏳ Posting to Slack...');
    await postToSlack(report);

    await logToRunLog('✅ Success', 'Weekly infrastructure health check generated and posted to #ai-engineering');
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
