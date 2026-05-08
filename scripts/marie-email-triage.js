/**
 * Marie Kondo — Email Triage
 *
 * Applies KonMari principles to Ben's inbox. Each email is evaluated:
 * does it serve a purpose? If not, it goes — with gratitude.
 *
 * Actions per email:
 *   TRASH    — retail, promotional, noise, expired notifications
 *   ARCHIVE  — newsletters worth keeping, service announcements
 *   RECEIPT  — billing/invoices → archive + label 'Receipts'
 *   PARENTS  — family emails → stay in inbox + label 'Parents' + star
 *   ACCOUNTS — dev platform updates → archive + label 'Accounts'
 *   TASK     — actionable emails → create Airtable task + archive
 *   DRAFT    — real person needs a reply → create Gmail draft + archive
 *   KEEP     — ambiguous or important → leave in inbox untouched
 *
 * Runs: Daily 8pm UTC (6am AEST) via GitHub Actions
 * Slack: Posts morning digest to #ai-engineering
 * Airtable: Logs each run to Run Log
 *
 * Required secrets:
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   GMAIL_USER_EMAIL
 *   ANTHROPIC_API_KEY
 *   AIRTABLE_API_KEY
 *   SLACK_BOT_TOKEN, SLACK_CHANNEL_AI_ENGINEERING
 *
 * Optional env vars:
 *   INITIAL_CLEANUP=true  — process up to MAX_INITIAL messages (for first run)
 *   DRY_RUN=true          — classify but take no action
 *   MAX_INITIAL=500       — how many emails to process on initial cleanup run
 */

const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const Airtable = require('airtable');
const axios = require('axios');

// ── Config ──────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const RUN_LOG = airtable.base('app6biS7yjV6XzFVG')('tblMahtVoLVT92NWJ');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL_AI_ENGINEERING;
const DRY_RUN = process.env.DRY_RUN === 'true';
const INITIAL_CLEANUP = process.env.INITIAL_CLEANUP === 'true';
const MAX_INITIAL = parseInt(process.env.MAX_INITIAL || '500', 10);
const DAILY_LOOKBACK_HOURS = 26; // slightly more than 24 to avoid gaps

const today = new Date().toISOString().split('T')[0];

// Gmail label IDs (fetched at runtime via getOrCreateLabel)
const labelCache = {};

// ── Gmail Auth ───────────────────────────────────────────────────────────────

function buildGmailClient() {
  const auth = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth });
}

// ── Gmail Helpers ────────────────────────────────────────────────────────────

async function getOrCreateLabel(gmail, name) {
  if (labelCache[name]) return labelCache[name];
  const res = await gmail.users.labels.list({ userId: 'me' });
  const existing = (res.data.labels || []).find(l => l.name === name);
  if (existing) { labelCache[name] = existing.id; return existing.id; }
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }
  });
  labelCache[name] = created.data.id;
  return created.data.id;
}

function getHeader(message, name) {
  const headers = message.payload?.headers || [];
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function getBody(message) {
  // Extract plain text body for emails that need content analysis
  const parts = message.payload?.parts || [];
  const textPart = parts.find(p => p.mimeType === 'text/plain');
  if (textPart?.body?.data) {
    return Buffer.from(textPart.body.data, 'base64').toString('utf-8').slice(0, 500);
  }
  return message.snippet || '';
}

async function fetchMessages(gmail, maxResults, afterTimestamp) {
  const messages = [];
  let pageToken;
  const query = afterTimestamp
    ? `in:inbox after:${Math.floor(afterTimestamp / 1000)}`
    : 'in:inbox';

  do {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(500, maxResults - messages.length),
      pageToken
    });
    const batch = res.data.messages || [];
    messages.push(...batch);
    pageToken = res.data.nextPageToken;
    if (messages.length >= maxResults) break;
  } while (pageToken);

  return messages.slice(0, maxResults);
}

async function getMessageDetails(gmail, id) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full'
  });
  return res.data;
}

async function trashMessage(gmail, id) {
  if (DRY_RUN) return;
  await gmail.users.messages.trash({ userId: 'me', id });
}

async function archiveMessage(gmail, id, labelIds = []) {
  if (DRY_RUN) return;
  const addLabelIds = labelIds;
  const removeLabelIds = ['INBOX'];
  await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: { addLabelIds, removeLabelIds }
  });
}

async function labelAndKeep(gmail, id, labelIds, star = false) {
  if (DRY_RUN) return;
  const addLabelIds = [...labelIds];
  if (star) addLabelIds.push('STARRED');
  await gmail.users.messages.modify({
    userId: 'me',
    id,
    requestBody: { addLabelIds }
  });
}

async function createDraftReply(gmail, message) {
  if (DRY_RUN) return;
  const from = getHeader(message, 'from');
  const subject = getHeader(message, 'subject');
  const messageId = getHeader(message, 'message-id');

  const toAddress = from.match(/<(.+?)>/) ? from.match(/<(.+?)>/)[1] : from;
  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

  const draftBody = [
    `Hi,`,
    ``,
    `Thanks for getting in touch. I'll get back to you shortly.`,
    ``,
    `— Ben`
  ].join('\n');

  const raw = [
    `To: ${toAddress}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${messageId}`,
    `References: ${messageId}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    draftBody
  ].join('\r\n');

  const encoded = Buffer.from(raw).toString('base64url');
  await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw: encoded, threadId: message.threadId }
    }
  });
}

// ── Airtable Task Creation ───────────────────────────────────────────────────

async function createAirtableTask(subject, description, dueDate, priority = 'Medium') {
  if (DRY_RUN) return;
  await airtable.base('app6biS7yjV6XzFVG')('tblaWsnrpapyjiIgi').create([{
    fields: {
      'fldRXiRmZFGPvWsXM': subject.substring(0, 200),
      'fldr07boWFbFqBO0i': description.substring(0, 1000),
      'fldP02iw62GD0wuVA': dueDate,
      'fld69Jaayh5XU1g8S': today,
      'fldfOGLWCc1mcqLZ3': 'Not started',
      'fldLUfo48cuUeuPE9': priority,
      'fldm42lpYOGw8e1OT': 'Ben',
      'fld7NgeI1SvCsVN6L': 'Email Triage',
      'fldShrdCCXjsGqr0A': 'Admin'
    }
  }]);
}

// ── Marie's Classification Engine ────────────────────────────────────────────

const MARIE_SYSTEM = `You are Marie Kondo, organizing Ben Collier's inbox using KonMari principles.

Your core question for every email: Does this serve a clear purpose? Can Ben act on it, does he need to keep it, or does it bring value to his work or life?

Ben runs Rascals Inc — 4 tech products (HypeBase, Fitspire, PromptKit, Rmtctrl). He is a solo founder based in Australia. His key contacts include: family (svcollier@hotmail.com), his own accounts (benwbcollier@gmail.com), developer platforms (Supabase, GitHub, Vercel, RapidAPI, Airtable, Sentry, Anthropic, Cloudflare).

Classify each email as exactly one of:
TRASH    — retail/fashion/travel marketing, promotional deals, contest emails, sale alerts, expired notifications, anything Ben clearly does not need. Be decisive. When in doubt between TRASH and ARCHIVE, choose TRASH.
ARCHIVE  — newsletters with occasional value (AI/tech/dev), service announcements requiring no action
RECEIPT  — billing receipts, invoices, order confirmations, payment notifications
PARENTS  — from svcollier@hotmail.com or any email about/for Ben's parents
ACCOUNTS — developer platform announcements and updates (RapidAPI, GitHub, Supabase, Vercel etc.)
TASK     — requires a specific decision or action from Ben within the next 14 days
DRAFT    — from a real human (not automated/noreply) who is waiting for Ben's reply
KEEP     — genuinely important or ambiguous — leave it for Ben

Rules:
- Retail/fashion/travel/deals = always TRASH. No exceptions.
- noreply/no-reply/mailer-daemon senders almost never need DRAFT
- TASK only when there is a specific action required, not just reading
- When uncertain between two categories, pick the more conservative one
- Respond with ONLY the category word, a pipe, and a max 8-word reason

Format: CATEGORY | reason
Example: TRASH | City Beach retail marketing, no value`;

async function classifyBatch(emails) {
  const lines = emails.map((e, i) =>
    `[${i}] From: ${e.from} | Subject: ${e.subject} | Snippet: ${e.snippet}`
  ).join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: MARIE_SYSTEM,
    messages: [{
      role: 'user',
      content: `Classify each of these ${emails.length} emails. One line per email, in order.\n\n${lines}`
    }]
  });

  const lines_out = response.content[0].text.trim().split('\n');
  return lines_out.map(line => {
    const [cat, reason] = line.split('|').map(s => s.trim());
    return { category: cat?.toUpperCase() || 'KEEP', reason: reason || '' };
  });
}

// ── Main Triage Loop ─────────────────────────────────────────────────────────

async function runTriage() {
  const gmail = buildGmailClient();

  // Determine how many messages to fetch
  const isInitial = INITIAL_CLEANUP;
  const lookbackMs = DAILY_LOOKBACK_HOURS * 60 * 60 * 1000;
  const afterTimestamp = isInitial ? null : Date.now() - lookbackMs;
  const maxMessages = isInitial ? MAX_INITIAL : 200;

  console.log(`🌸 Marie Kondo — Email Triage — ${today}`);
  console.log(`   Mode: ${isInitial ? `Initial cleanup (max ${maxMessages})` : `Daily (last ${DAILY_LOOKBACK_HOURS}h)`}`);
  if (DRY_RUN) console.log('   🔵 DRY RUN — classifying only, no actions');

  // Pre-fetch label IDs we'll need
  const [receiptsLabel, parentsLabel, accountsLabel] = await Promise.all([
    getOrCreateLabel(gmail, 'Receipts'),
    getOrCreateLabel(gmail, 'Parents'),
    getOrCreateLabel(gmail, 'Accounts')
  ]);

  // Fetch messages
  console.log('📬 Fetching messages...');
  const messageRefs = await fetchMessages(gmail, maxMessages, afterTimestamp);
  console.log(`   Found ${messageRefs.length} messages to process`);

  if (messageRefs.length === 0) {
    return { processed: 0, trashed: 0, archived: 0, tasksCreated: 0, draftsCreated: 0, kept: 0 };
  }

  // Process in batches of 20
  const BATCH_SIZE = 20;
  const counts = { trashed: 0, archived: 0, tasksCreated: 0, draftsCreated: 0, kept: 0, errors: 0 };
  const taskLog = [];
  const draftLog = [];
  const flaggedLog = [];

  for (let i = 0; i < messageRefs.length; i += BATCH_SIZE) {
    const batch = messageRefs.slice(i, i + BATCH_SIZE);
    console.log(`   Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messageRefs.length / BATCH_SIZE)}...`);

    // Fetch full details for this batch
    const details = await Promise.all(batch.map(ref => getMessageDetails(gmail, ref.id).catch(() => null)));
    const valid = details.filter(Boolean);

    // Build classification inputs
    const classInputs = valid.map(msg => ({
      id: msg.id,
      threadId: msg.threadId,
      from: getHeader(msg, 'from'),
      subject: getHeader(msg, 'subject'),
      snippet: msg.snippet?.slice(0, 100) || '',
      msg
    }));

    // Classify the batch
    let classifications;
    try {
      classifications = await classifyBatch(classInputs);
    } catch (err) {
      console.warn(`   ⚠️  Classification error: ${err.message} — keeping all as KEEP`);
      classifications = classInputs.map(() => ({ category: 'KEEP', reason: 'classification error' }));
    }

    // Execute actions
    for (let j = 0; j < classInputs.length; j++) {
      const { id, from, subject, msg } = classInputs[j];
      const { category, reason } = classifications[j] || { category: 'KEEP', reason: '' };

      try {
        switch (category) {
          case 'TRASH':
            await trashMessage(gmail, id);
            counts.trashed++;
            break;

          case 'ARCHIVE':
            await archiveMessage(gmail, id);
            counts.archived++;
            break;

          case 'RECEIPT':
            await archiveMessage(gmail, id, [receiptsLabel]);
            counts.archived++;
            break;

          case 'PARENTS':
            await labelAndKeep(gmail, id, [parentsLabel], true);
            counts.kept++;
            break;

          case 'ACCOUNTS':
            await archiveMessage(gmail, id, [accountsLabel]);
            counts.archived++;
            break;

          case 'TASK': {
            const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const desc = `Email from: ${from}\nSubject: ${subject}\nReason flagged: ${reason}\n\nSnippet: ${msg.snippet || ''}`;
            await createAirtableTask(`Email: ${subject.slice(0, 150)}`, desc, dueDate, 'Medium');
            await archiveMessage(gmail, id);
            counts.tasksCreated++;
            taskLog.push(`→ ${subject.slice(0, 60)}`);
            break;
          }

          case 'DRAFT':
            await createDraftReply(gmail, msg);
            await archiveMessage(gmail, id);
            counts.draftsCreated++;
            draftLog.push(`→ Re: ${subject.slice(0, 60)} (to: ${from.slice(0, 40)})`);
            break;

          case 'KEEP':
          default:
            counts.kept++;
            flaggedLog.push(`→ ${subject.slice(0, 60)}`);
            break;
        }
      } catch (err) {
        console.warn(`   ⚠️  Action error (${id}): ${err.message}`);
        counts.errors++;
      }
    }

    // Small delay between batches to respect API rate limits
    if (i + BATCH_SIZE < messageRefs.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return {
    processed: messageRefs.length,
    ...counts,
    taskLog,
    draftLog,
    flaggedLog
  };
}

// ── Slack Summary ─────────────────────────────────────────────────────────────

async function postToSlack(results) {
  const { processed, trashed, archived, tasksCreated, draftsCreated, kept, taskLog, draftLog, flaggedLog, errors } = results;

  const lines = [
    `🌸 *Marie Kondo — Morning Email Triage — ${today}*`,
    ``,
    `*Processed:* ${processed} emails`,
    `*Trashed:* ${trashed} | *Archived:* ${archived} | *Kept:* ${kept}`,
    ``
  ];

  if (tasksCreated > 0) {
    lines.push(`📋 *Tasks created (${tasksCreated}):*`);
    taskLog.slice(0, 5).forEach(t => lines.push(t));
    if (taskLog.length > 5) lines.push(`  ...and ${taskLog.length - 5} more`);
    lines.push('');
  }

  if (draftsCreated > 0) {
    lines.push(`✍️ *Drafts queued (${draftsCreated}):*`);
    draftLog.slice(0, 5).forEach(d => lines.push(d));
    lines.push('');
  }

  if (flaggedLog.length > 0) {
    lines.push(`🔍 *Left in inbox for you (${flaggedLog.length}):*`);
    flaggedLog.slice(0, 5).forEach(f => lines.push(f));
    if (flaggedLog.length > 5) lines.push(`  ...and ${flaggedLog.length - 5} more`);
    lines.push('');
  }

  if (errors > 0) lines.push(`⚠️ ${errors} errors — check run log`);

  if (DRY_RUN) {
    console.log('🔵 DRY RUN Slack output:\n' + lines.join('\n'));
    return;
  }

  const response = await axios.post(
    'https://slack.com/api/chat.postMessage',
    { channel: SLACK_CHANNEL, text: lines.join('\n'), username: 'Marie Kondo', icon_emoji: ':blossom:' },
    { headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  if (!response.data.ok) throw new Error(`Slack error: ${response.data.error}`);
}

// ── Run Log ───────────────────────────────────────────────────────────────────

async function logToRunLog(status, summary) {
  await RUN_LOG.create([{ fields: {
    'Run ID': `Marie — Email Triage — ${today}`,
    Status: status,
    Date: today,
    Summary: summary.substring(0, 500),
    'Workflow File': 'marie-email-triage.yml'
  }}]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const results = await runTriage();
    await postToSlack(results);

    const summary = `Processed ${results.processed}. Trashed ${results.trashed}, archived ${results.archived}, created ${results.tasksCreated} tasks, queued ${results.draftsCreated} drafts, kept ${results.kept}.`;
    console.log(`✅ Done. ${summary}`);
    if (!DRY_RUN) await logToRunLog('✅ Success', summary);

  } catch (err) {
    console.error('❌ Error:', err.message);
    try { await logToRunLog('❌ Failed', err.message); } catch (_) {}
    process.exit(1);
  }
}

main();
