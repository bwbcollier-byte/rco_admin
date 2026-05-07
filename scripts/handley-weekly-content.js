/**
 * Ann Handley — Weekly Content Brief
 * Runs Friday 7:30am AEST. Generates a content angle for the week ahead
 * and flags any content calendar gaps. Posts to #growth-marketing.
 *
 * Note: Content calendar tracking is manual at this stage — the brief
 * generates angles and accountability, not automated calendar reads.
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

// Day of year — used to rotate through content angles
const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);

// Rotating content angles for HypeBase and PromptKit
const HYPEBASE_ANGLES = [
  'The data gap talent managers don\'t know they have — and what it costs them',
  'How streaming trajectory data changes the conversation before a brand deal',
  'What "artist data" actually means vs. what most managers think it means',
  'The 3 data points every indie music manager should track but doesn\'t',
  'How to spot a brand conflict before you sign the deal',
  'Why social follower count is the most misleading artist metric',
  'The difference between an artist\'s public profile and their actual commercial trajectory',
  'What a talent manager actually needs from a data platform (and what they don\'t)',
];

const PROMPTKIT_ANGLES = [
  'The prompt that makes every UI design review faster',
  'How to build a reusable prompt library for your design team',
  'The difference between a prompt that works once and one that works every time',
  'Why most designers use AI wrong — and how PromptKit fixes it',
  'A design system for AI prompts: what it is and why you need one',
];

async function generateBrief() {
  const hbAngle = HYPEBASE_ANGLES[dayOfYear % HYPEBASE_ANGLES.length];
  const pkAngle = PROMPTKIT_ANGLES[dayOfYear % PROMPTKIT_ANGLES.length];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: `You are Ann Handley, Chief Content Officer of MarketingProfs. You write with pathological empathy for the reader. You are specific, never vague. You edit ruthlessly. Every content recommendation you make passes the "so what?" test.`,
    messages: [{ role: 'user', content: `Produce the weekly content brief for Rascals Inc. Date: ${today}.

CONTENT ANGLE THIS WEEK:
HypeBase angle: "${hbAngle}"
PromptKit angle: "${pkAngle}"

Format:
## ✍️ Content Brief — ${today}

### This Week's HypeBase Angle
[Develop the angle into a specific content piece: working title, target reader, the "so what", recommended format (LinkedIn post / article / email)]

### This Week's PromptKit Angle
[Same treatment]

### The Editorial Standard This Week
[One specific writing craft reminder — e.g. "Kill every sentence that starts with 'We'. Rewrite to start with 'You'."]

### Content Calendar Accountability
[Flag: was content published last week? If this is the first run, just note "baseline week"]

Under 250 words. Be specific. No content marketing clichés.` }]
  });
  return response.content[0].text;
}

async function postToSlack(brief) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', brief); return; }
  const res = await axios.post('https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: brief, username: 'Ann Handley', icon_emoji: ':pencil:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: { 'Run ID': `Handley — Weekly Content Brief — ${today}`, Status: status, Date: today, Summary: notes.substring(0, 500), 'Workflow File': 'handley-weekly-content.yml' } }]);
}

async function main() {
  console.log(`✍️  Ann Handley — Weekly Content Brief — ${today}`);
  try {
    const brief = await generateBrief();
    await postToSlack(brief);
    await logToRunLog('✅ Success', 'Weekly content brief posted to #growth-marketing');
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}
main();
