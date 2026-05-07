/**
 * Simon Willison — Weekly Scraper Triage
 *
 * Runs every Wednesday 7:30am AEST via GitHub Actions.
 * Technical deep-dive that complements Hightower's health check:
 * - Classifies each failure as CREDENTIAL / RATE_LIMIT / DETECTION / CODE_BUG / INFRA
 * - Identifies LLM extraction candidates
 * - Recommends the single most impactful scraper fix this week
 *
 * Required secrets: ANTHROPIC_API_KEY, AIRTABLE_API_KEY,
 *                   SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING
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

async function getFailingScrapers() {
  try {
    const records = await RUN_LOG.select({
      filterByFormula: `AND(
        IS_AFTER({Date}, DATEADD(TODAY(), -7, 'days')),
        FIND('yl-hb', {Repo})
      )`,
      fields: ['Run ID', 'Status', 'Date', 'Repo', 'Summary']
    }).all();

    // Group by repo and find failures
    const byRepo = {};
    for (const r of records) {
      const repo = (r.get('Repo') || 'unknown').trim();
      if (!byRepo[repo]) byRepo[repo] = { runs: 0, failures: [] };
      byRepo[repo].runs++;
      const status = (r.get('Status') || '').toLowerCase();
      if (!status.includes('✅') && status !== 'success') {
        byRepo[repo].failures.push({
          date: r.get('Date') || '',
          notes: (r.get('Summary') || '').substring(0, 300)
        });
      }
    }

    const failing = Object.entries(byRepo)
      .filter(([_, data]) => data.failures.length > 0)
      .map(([repo, data]) => ({
        repo,
        runs: data.runs,
        failCount: data.failures.length,
        recentNotes: data.failures[0]?.notes || ''
      }));

    return { failing, total: Object.keys(byRepo).length, error: null };
  } catch (err) {
    console.warn('⚠️  Run Log error:', err.message);
    return { error: err.message };
  }
}

async function generateTriage(data) {
  const failingSection = data.error
    ? `Error fetching Run Log: ${data.error}`
    : data.failing.length === 0
      ? 'No scraper failures recorded this week — all yl-hb-* scrapers green.'
      : data.failing.map(f =>
          `Repo: ${f.repo} | ${f.failCount}/${f.runs} runs failed\nError notes: ${f.recentNotes || 'none logged'}`
        ).join('\n\n');

  const prompt = `Produce the weekly scraper triage brief for Rascals Inc. Date: ${today}.

Total scrapers active: ${data.total || 'unknown'}

FAILING SCRAPERS THIS WEEK:
${failingSection}

For each failing scraper, classify the failure type:
- CREDENTIAL: expired cookie, rotated API key, token invalid
- RATE_LIMIT: HTTP 429, quota exceeded, too many requests
- DETECTION: Cloudflare block, CAPTCHA, bot fingerprint
- CODE_BUG: selector changed, unexpected page structure, logic error
- INFRA: timeout, memory, GitHub Actions runner issue
- UNKNOWN: not enough information to classify

Format:

## 🕷️ Scraper Triage — ${today}

### Failure Classification
| Repo | Type | Evidence | Fix |
| ---- | ---- | -------- | --- |
[one row per failing scraper]

### LLM Extraction Candidates
[Scrapers where replacing DOM parsing with Claude extraction would improve reliability. Only list if genuinely applicable.]

### This Week's One Fix
[The single highest-impact fix. Specific. Named repo. Concrete steps. Time estimate.]

Under 300 words. Technical, not managerial. If no failures, just confirm green and note any observations.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: `You are Simon Willison, creator of Datasette and practical LLM engineer. You know scraping intimately. You classify failures precisely before suggesting fixes. You distinguish credential failures (fix the credential) from detection failures (fix the approach). You are direct and ship working code. You don't recommend LLM extraction for every scraper — only where it genuinely helps.`,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

async function postToSlack(triage) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', triage); return; }
  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: triage, username: 'Simon Willison', icon_emoji: ':spider_web:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  if (!response.data.ok) throw new Error(`Slack error: ${response.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: {
    'Run ID': `Willison — Weekly Scraper Triage — ${today}`,
    Status: status, Date: today,
    Summary: notes.substring(0, 500),
    'Workflow File': 'willison-weekly-scraper-triage.yml'
  }}]);
}

async function main() {
  console.log(`🕷️  Simon Willison — Weekly Scraper Triage — ${today}`);
  if (DRY_RUN) console.log('🔵 DRY RUN mode active');
  try {
    const data = await getFailingScrapers();
    const triage = await generateTriage(data);
    await postToSlack(triage);
    await logToRunLog('✅ Success', 'Weekly scraper triage posted to #ai-engineering');
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌ Error:', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}

main();
