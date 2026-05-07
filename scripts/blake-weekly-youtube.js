/**
 * Roberto Blake — Weekly YouTube Brief
 * Runs Friday 8:30am AEST. Pre-launch: rotating video ideas + upload cadence accountability.
 * Post-launch: add YouTube Data API v3 for real analytics.
 * Posts to #growth-marketing.
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

// Rotating video ideas by product
const PROMPTKIT_VIDEOS = [
  { title: 'My Design Workflow with AI Prompts (PromptKit Walkthrough)', keyword: 'AI prompts for UI design' },
  { title: 'How to Build a Prompt Library for Your Design Team', keyword: 'design prompt library' },
  { title: 'The Best Figma Prompt Templates in 2026', keyword: 'Figma prompt templates' },
  { title: 'Stop Writing AI Prompts From Scratch — Do This Instead', keyword: 'AI prompt templates designers' },
  { title: '5 AI Prompts Every UI Designer Should Save', keyword: 'UI design AI prompts' },
];

const HYPEBASE_VIDEOS = [
  { title: 'How Talent Managers Can Use AI Data (HypeBase Walkthrough)', keyword: 'talent management data tools' },
  { title: 'Artist Data 101: What Every Music Manager Should Track', keyword: 'artist data management' },
  { title: 'Finding Brand Conflicts Before They Happen — Music Industry Data', keyword: 'artist brand conflict data' },
];

const weekNumber = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 1)) / (7 * 86400000));
const pkVideo = PROMPTKIT_VIDEOS[weekNumber % PROMPTKIT_VIDEOS.length];
const hbVideo = HYPEBASE_VIDEOS[weekNumber % HYPEBASE_VIDEOS.length];

async function generateBrief() {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `You are Roberto Blake, YouTube creator strategist. You know that thumbnails and titles win before a second plays. Consistency beats perfection. Search-optimised evergreen content compounds. You hold people accountable for upload cadence. You are direct.`,
    messages: [{ role: 'user', content: `Weekly YouTube brief for Rascals Inc. Date: ${today}.

VIDEO IDEAS THIS WEEK:
PromptKit: "${pkVideo.title}" — target keyword: "${pkVideo.keyword}"
HypeBase: "${hbVideo.title}" — target keyword: "${hbVideo.keyword}"

Format:
## 🎬 YouTube Brief — ${today}

### Upload Accountability
[Did a video publish last week? If channels are new, note "channel setup" as the task]

### This Week's Priority Video
[Expand on the PromptKit idea — it has the clearest near-term opportunity. Include:
- Recommended thumbnail concept (2 sentences)
- Hook for the first 10 seconds
- 3 chapter markers / key moments]

### HypeBase Video on Deck
[One sentence — keep it warm for when product is ready to demo]

### One Channel Setup Task
[If no channel exists yet: specific setup step. If channel exists: optimisation task.]

Under 200 words.` }]
  });
  return response.content[0].text;
}

async function postToSlack(brief) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', brief); return; }
  const res = await axios.post('https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: brief, username: 'Roberto Blake', icon_emoji: ':clapper:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: { 'Run ID': `Blake — Weekly YouTube Brief — ${today}`, Status: status, Date: today, Summary: notes.substring(0, 500), 'Workflow File': 'blake-weekly-youtube.yml' } }]);
}

async function main() {
  console.log(`🎬 Roberto Blake — Weekly YouTube Brief — ${today}`);
  try {
    const brief = await generateBrief();
    await postToSlack(brief);
    await logToRunLog('✅ Success', 'Weekly YouTube brief posted to #growth-marketing');
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}
main();
