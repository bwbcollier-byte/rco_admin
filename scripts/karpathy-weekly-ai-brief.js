/**
 * Andrej Karpathy — Weekly AI/ML Brief
 *
 * Runs every Wednesday 7am AEST via GitHub Actions.
 * 1. Fetches recent AI/ML news from Simon Willison's Datasette (public JSON) + HuggingFace papers
 * 2. Calls Claude (Haiku) with Karpathy's system prompt to produce a focused brief
 * 3. Posts to Slack #ai-engineering
 * 4. Logs run to Airtable Run Log
 *
 * Required secrets in rco_admin:
 *   ANTHROPIC_API_KEY
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN
 *   SLACK_CHANNEL_AI_ENGINEERING
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

// ── Data Collection ─────────────────────────────────────────────────────────

async function fetchOpenAIBlog() {
  try {
    // OpenAI news RSS (reliable public feed)
    const response = await axios.get('https://openai.com/news/rss.xml', { timeout: 10000 });
    const items = [];
    const matches = response.data.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/g);
    let count = 0;
    for (const match of matches) {
      if (count >= 3) break;
      items.push({ title: match[1], date: match[2] });
      count++;
    }
    // Fallback: try plain <title> tags if CDATA not found
    if (items.length === 0) {
      const plain = response.data.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<\/item>/g);
      let c = 0;
      for (const m of plain) {
        if (c >= 3) break;
        items.push({ title: m[1], date: '' });
        c++;
      }
    }
    return items;
  } catch (err) {
    console.warn('⚠️  OpenAI blog fetch failed:', err.message);
    return [];
  }
}

async function fetchHuggingFacePapers() {
  try {
    // HuggingFace Daily Papers API
    const response = await axios.get('https://huggingface.co/api/daily_papers?limit=5', { timeout: 10000 });
    return (response.data || []).slice(0, 5).map(p => ({
      title: p.paper?.title || p.title || 'Unknown',
      abstract: (p.paper?.abstract || '').substring(0, 200)
    }));
  } catch (err) {
    console.warn('⚠️  HuggingFace papers fetch failed:', err.message);
    return [];
  }
}

async function getAIData() {
  const [openaiNews, hfPapers] = await Promise.all([
    fetchOpenAIBlog(),
    fetchHuggingFacePapers()
  ]);
  return { openaiNews, hfPapers };
}

// ── Report Generation ───────────────────────────────────────────────────────

async function generateBrief(data) {
  const openaiSection = data.openaiNews.length > 0
    ? data.openaiNews.map(n => `- ${n.title}`).join('\n')
    : 'No recent OpenAI news fetched this week.';

  const hfSection = data.hfPapers.length > 0
    ? data.hfPapers.map(p => `- ${p.title}: ${p.abstract}`).join('\n')
    : 'No HuggingFace papers fetched this week.';

  const prompt = `Produce this week's AI/ML research brief for Rascals Inc. Date: ${today}.

OPENAI NEWS THIS WEEK:
${openaiSection}

RECENT RESEARCH PAPERS (HuggingFace Daily Papers):
${hfSection}

Evaluate each item against Rascals Inc's immediate AI needs:
1. HypeBase entity resolution (cross-source artist deduplication via embeddings)
2. Fitspire workout recommendation (retrieval-based)
3. Scraper LLM extraction (replacing brittle DOM parsing in yl-hb-* scrapers)
4. Evaluation infrastructure (measuring AI output quality systematically)

Format exactly:

## 🧠 AI/ML Brief — ${today}

### This Week's Signal
[1-2 items genuinely worth acting on — skip section entirely if nothing material this week]

### Relevant to Rascals Stack
[Items that apply directly — 1 sentence each, concrete application stated]

### Model & Tooling Updates
[Any cost/capability changes worth noting]

### One Experiment to Run This Week
[A specific, low-cost AI experiment. Concrete enough to start in an afternoon. Skip if nothing obvious.]

Under 300 words. Skip academic hedging. If data was sparse this week, say so plainly.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: `You are Andrej Karpathy, AI researcher and educator. You care about practical ML engineering, evaluation, and inference cost. You cut through hype and focus on what a small team can actually use. You think in terms of Software 2.0 — where learned systems replace hand-written rules. You are direct and do not pad responses.`,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

// ── Output ──────────────────────────────────────────────────────────────────

async function postToSlack(brief) {
  if (DRY_RUN) {
    console.log('🔵 DRY RUN — Slack post skipped. Brief:\n');
    console.log(brief);
    return;
  }

  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    {
      channel: SLACK_CHANNEL,
      text: brief,
      username: 'Andrej Karpathy',
      icon_emoji: ':brain:'
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
      'Run ID': `Karpathy — Weekly AI/ML Brief — ${today}`,
      Status: status,
      Date: today,
      Summary: notes.substring(0, 500),
      'Workflow File': 'karpathy-weekly-ai-brief.yml'
    }
  }]);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🧠 Andrej Karpathy — Weekly AI/ML Brief — ${today}`);
  if (DRY_RUN) console.log('🔵 DRY RUN mode active');

  try {
    console.log('⏳ Fetching AI/ML news...');
    const data = await getAIData();
    console.log(`Fetched: ${data.anthropicNews.length} Anthropic items, ${data.hfPapers.length} HF papers`);

    console.log('⏳ Generating Karpathy brief...');
    const brief = await generateBrief(data);

    console.log('⏳ Posting to Slack...');
    await postToSlack(brief);

    await logToRunLog('✅ Success', 'Weekly AI/ML brief generated and posted to #ai-engineering');
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
