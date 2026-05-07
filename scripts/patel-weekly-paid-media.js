/**
 * Neil Patel — Weekly Paid Media Report
 * Runs Friday 8am AEST. Pre-launch: generates pre-launch setup checklist
 * and readiness assessment. Once campaigns go live, switches to performance reporting.
 * Posts to #growth-marketing.
 *
 * Phase 1 (pre-launch): readiness checklist + one setup action
 * Phase 2 (post-launch): campaign performance summary (requires manual data input or ad API)
 *
 * Required secrets: ANTHROPIC_API_KEY, AIRTABLE_API_KEY,
 *                   SLACK_BOT_TOKEN, SLACK_CHANNEL_GROWTH_MARKETING
 */

const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const RUN_LOG = airtable.base('app6biS7yjV6XzFVG')('tblMahtVoLVT92NWJ');
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_GROWTH_MARKETING;
const DRY_RUN = process.env.DRY_RUN === 'true';
const today = new Date().toISOString().split('T')[0];

// Pre-launch readiness checklist — rotates through items each week
const READINESS_ITEMS = [
  { item: 'UTM parameter structure defined', action: 'Create UTM naming convention doc covering Google/Meta/LinkedIn/email channels' },
  { item: 'GA4 or PostHog tracking on HypeBase web property', action: 'Verify analytics tag fires on all pages; check conversion events are tracked' },
  { item: 'Google Ads account created and verified', action: 'Create account at ads.google.com, complete billing setup, verify domain ownership' },
  { item: 'Meta Business Manager connected to ad account', action: 'Create Business Manager, add ad account, install Meta Pixel on web properties' },
  { item: 'LinkedIn Campaign Manager account set up', action: 'Create LinkedIn ad account, install Insight Tag on HypeBase website' },
  { item: 'Landing page conversion rate baseline', action: 'Set up A/B test on HypeBase landing page — headline variation vs control' },
  { item: 'Audience lists built (remarketing)', action: 'Create website visitor audiences in all ad platforms (minimum 1,000 visitors needed)' },
  { item: 'CAC model defined', action: 'Estimate target CAC based on LTV assumptions — set kill criteria before first spend' },
];

const weekNumber = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 1)) / (7 * 86400000));
const currentItem = READINESS_ITEMS[weekNumber % READINESS_ITEMS.length];

async function generateReport() {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `You are Neil Patel, digital marketing expert and paid acquisition specialist. You are data-driven and attribution-obsessed. Pre-launch, you focus on infrastructure setup. You never run paid without tracking in place. You are direct and give one specific action, not a list.`,
    messages: [{ role: 'user', content: `Weekly paid media report for Rascals Inc. Date: ${today}.

STATUS: Pre-launch — no active paid campaigns.

THIS WEEK'S READINESS FOCUS:
Item: "${currentItem.item}"
Recommended action: "${currentItem.action}"

Format:
## 💰 Paid Media — ${today}

### Campaign Status
Pre-launch. No active spend. [N weeks until readiness]

### This Week's Setup Priority
[Expand on the readiness item with specific steps — make it actionable today]

### What Blocks First Dollar
[The single thing that must be true before we spend one dollar on paid — be direct]

Under 150 words.` }]
  });
  return response.content[0].text;
}

async function postToSlack(report) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', report); return; }
  const res = await axios.post('https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: report, username: 'Neil Patel', icon_emoji: ':money_with_wings:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: { 'Run ID': `Patel — Weekly Paid Media Report — ${today}`, Status: status, Date: today, Summary: notes.substring(0, 500), 'Workflow File': 'patel-weekly-paid-media.yml' } }]);
}

async function main() {
  console.log(`💰 Neil Patel — Weekly Paid Media Report — ${today}`);
  try {
    const report = await generateReport();
    await postToSlack(report);
    await logToRunLog('✅ Success', 'Weekly paid media report posted to #growth-marketing');
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}
main();
