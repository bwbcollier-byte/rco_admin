/**
 * Patty McCord — Monthly Hiring Readiness Check
 * Runs first Monday of each month, 7:00am AEST.
 * Pre-hire: rotating preparation tasks to build people infrastructure before first hire.
 * Post-hire: update to include real team metrics.
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

// Only run on the first Monday of the month
function isFirstMondayOfMonth() {
  const now = new Date();
  return now.getDate() <= 7;
}

// Rotating monthly preparation themes — pre-hire track
const MONTHLY_THEMES = [
  {
    theme: 'Trigger Conditions',
    task: 'Define the exact trigger for first hire: what revenue, milestone, or event means "time to hire"? Write it down.',
    question: 'If the company hits this milestone tomorrow, are you ready to start hiring within 2 weeks?'
  },
  {
    theme: 'First Role Definition',
    task: 'Define the function — not the title — of the first hire. What specific bottleneck does this person solve? What does success look like in their first 90 days?',
    question: 'If this person left after 30 days, would you fight to keep them? If not, the role definition is wrong.'
  },
  {
    theme: 'Culture Document',
    task: 'Write 3-5 core values for Rascals. Not aspirational — actual behaviours already present in how decisions get made. These are your hiring filter.',
    question: 'What question would you ask every candidate that reveals whether they share these values?'
  },
  {
    theme: 'Compensation Research',
    task: 'Research market rate for the first hire role. Check: levels.fyi, LinkedIn Salary, Seek.com.au. Know the number before you post.',
    question: 'At current runway, can you afford this hire for 12 months even if revenue is slower than planned?'
  },
  {
    theme: 'Contractor vs Full-Time',
    task: 'Decide: is the first engagement a contractor, fractional hire, or full-time? Each has different tax, IP, and commitment implications in Australia.',
    question: 'At this stage of certainty, is a contractor the right structure, or are you ready to commit to an employee?'
  },
  {
    theme: 'Sourcing Strategy',
    task: 'Where will you find candidates? Make a shortlist: LinkedIn, Seek, referrals, communities (Indie Hackers, local AI/music tech meetups). Which is most likely to reach the right person?',
    question: 'Is there someone in your existing network who would be perfect for this role?'
  },
  {
    theme: 'Interview Process',
    task: 'Design the assessment process: screening call (30 min) → work sample → reference check. Write the 3 screening questions that reveal whether someone is worth the deeper conversation.',
    question: 'What would a strong "no" look like after the screening call? Have you defined it?'
  },
  {
    theme: 'Onboarding Plan',
    task: 'Write a 30-day onboarding plan for the first hire. Day 1, week 1, month 1. What do they need to know, do, and produce?',
    question: 'If this person started tomorrow, would they be productive within 2 weeks, or would they be blocked waiting on you?'
  },
  {
    theme: 'Feedback Framework',
    task: 'Design the performance feedback process. Not annual reviews — frequent, honest, specific. Write the script for giving hard feedback: "I noticed X. It matters because Y. I need Z instead."',
    question: 'When was the last time you gave someone direct, specific, uncomfortable-but-necessary feedback?'
  },
  {
    theme: 'Exit Framework',
    task: 'Define the exit criteria: if this hire isn\'t working, what signals tell you that, and what do you do? Have the honest conversation early — don\'t wait for the situation to become untenable.',
    question: 'Apply the keeper test: if this person got a great offer and left after 6 months, would you be relieved?'
  },
  {
    theme: 'Legal & Contractor Setup',
    task: 'Check: do you have the correct legal infrastructure to hire in Australia? Entity type, ABN, contractor agreements, IP assignment clauses. Get legal review before making an offer.',
    question: 'Is there a contractor agreement template ready, or will you be scrambling when you find the right person?'
  },
  {
    theme: 'Annual Review',
    task: 'Review the year: what people-related decisions were made? What was the actual bottleneck that needed a hire? Has the trigger condition been reached?',
    question: 'Looking at the year honestly: did the absence of a hire limit progress, or was the solo operation the right call?'
  }
];

const monthIndex = new Date().getMonth(); // 0-11
const theme = MONTHLY_THEMES[monthIndex % MONTHLY_THEMES.length];

async function generateBrief() {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 350,
    system: `You are Patty McCord, former Chief Talent Officer at Netflix and creator of the Netflix Culture Deck. You are direct, honest, and practical about people operations. You believe the best HR strategy is hiring the right person at the right time and having honest conversations. You hold founders accountable for doing the people work before they need to do it urgently.`,
    messages: [{ role: 'user', content: `Monthly hiring readiness check for Rascals Inc. Date: ${today}. Month: ${new Date().toLocaleString('en-AU', { month: 'long' })}.

This month's theme: "${theme.theme}"
Preparation task: "${theme.task}"
Key question: "${theme.question}"

Format:
## 👥 Hiring Readiness — ${new Date().toLocaleString('en-AU', { month: 'long', year: 'numeric' })}

### This Month: ${theme.theme}
[2-3 sentences expanding on why this month's theme matters right now for a pre-revenue solo founder building toward their first hire]

### The Task
[Restate the task clearly — 1-2 sentences. Make it actionable, not vague.]

### The Question to Answer
[Restate the key question. Add one specific observation about why this question matters for Rascals specifically.]

### Keeper Test
[One sentence: apply the keeper test to the current state of hiring readiness — are we building the right foundation?]

Under 200 words total.` }]
  });
  return response.content[0].text;
}

async function postToSlack(brief) {
  if (DRY_RUN) { console.log('🔵 DRY RUN\n', brief); return; }
  const res = await axios.post('https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: brief, username: 'Patty McCord', icon_emoji: ':busts_in_silhouette:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
}

async function logToRunLog(status, notes) {
  await RUN_LOG.create([{ fields: { 'Run ID': `McCord — Monthly Hiring Readiness — ${today}`, Status: status, Date: today, Summary: notes.substring(0, 500), 'Workflow File': 'mccord-monthly-hiring.yml' } }]);
}

async function main() {
  console.log(`👥 Patty McCord — Monthly Hiring Readiness — ${today}`);

  if (!isFirstMondayOfMonth()) {
    console.log('Not first Monday of month — skipping.');
    return;
  }

  try {
    const brief = await generateBrief();
    await postToSlack(brief);
    await logToRunLog('✅ Success', `Monthly hiring readiness posted — theme: ${theme.theme}`);
    console.log('✅ Done.');
  } catch (err) {
    console.error('❌', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}
main();
