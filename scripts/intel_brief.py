#!/usr/bin/env python3
"""
Intel Brief — runs Mon/Thu via GitHub Actions.

Reads Gemini-pre-evaluated items from Airtable (Skills, Intel Feed, APIs),
uses Claude Haiku to write Claude Prompts + Task descriptions for actionable items,
uses Gemini to compose the Slack brief, posts to Slack, logs the run.

Stdlib only. No third-party deps.

Env vars required:
  ANTHROPIC_API_KEY      Claude API key (Haiku model)
  AIRTABLE_API_KEY       PAT with data.records:read/write on base app6biS7yjV6XzFVG
  GEMINI_API_KEY         Google Gemini key (or loaded from Airtable Logins & Keys)
  TRIAGE_SLACK_WEBHOOK   Slack incoming webhook URL (or set via ~/.claude/.env)
"""
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib import request, error
from urllib.parse import quote

# ──────────────────────────── Airtable layout ────────────────────────────

AIRTABLE_BASE = "app6biS7yjV6XzFVG"

TABLE_SKILLS          = "tblRYHxXNItKHXqg7"
TABLE_INTEL_FEED      = "tblwX27CIfhUPAm7J"
TABLE_APIS_V2         = "tblMb9HFyKcnQ7aKb"
TABLE_STACK_PLATFORMS = "tblRzDbDhgH4cv0s9"
TABLE_TASKS           = "tblaWsnrpapyjiIgi"
TABLE_ROUTINE_RUNS    = "tblMahtVoLVT92NWJ"
TABLE_LOGINS_KEYS     = "tbldJkG11gY1W3jTf"

# Skills
F_S_NAME          = "fldWkR24Xvv9QwlhC"
F_S_TYPE          = "fldkprz8WpS1ISkbC"
F_S_DESC          = "fld9gzPlHxkvTaYti"
F_S_SOURCE_URL    = "fldsPZ14Bt4wuWxhH"
F_S_RELEVANCE     = "fldpHZvluU0FZQpln"
F_S_EFFORT        = "fldnxq8CkjFALhEh7"
F_S_AUDIT_NOTES   = "fldswaN5jLkCzogde"
F_S_DECISION      = "fldPJ6wAxORMAX59E"
F_S_CLAUDE_PROMPT = "fldFCCSZrU7PUmv3G"
F_S_LAST_AUDITED  = "fldR60TGsI3N3fxjG"
F_S_DATE_FOUND    = "fld1leHJYMR7A3CAD"

# Intel Feed
F_IF_TITLE         = "fldz126GxHrT2LNvd"
F_IF_FEED_TYPE     = "fldOJjF4CHVFUTDnI"
F_IF_SOURCE        = "fldVDf9XduKHz0cnD"
F_IF_SOURCE_URL    = "fldbuIajYp1uKV9Fu"
F_IF_DATE_FOUND    = "fldhHCyKchpTnLn5H"
F_IF_SUMMARY       = "fldbaO4lSEliQTnAP"
F_IF_DESCRIPTION   = "fldtNIUixmSbBmgUt"
F_IF_WHY           = "flddwIXL5VxOkSLPN"
F_IF_USE_CASE_1    = "fldp60fJmcVtZ59gO"
F_IF_USE_CASE_2    = "fldtgGmMFPg745cPA"
F_IF_PLATFORM_TIER = "fldUvWNsQiHPN8kP6"
F_IF_EFFORT        = "fldyjfqlLKJmr50Jr"
F_IF_RELEVANCE     = "fldCv4CQsqJJPRD0a"
F_IF_DECISION      = "fldvbbRANVEpL37MA"
F_IF_NOTES         = "fldM8wNT4PV0OcC9J"
F_IF_CLAUDE_PROMPT = "fldRDuEpkePw3wCij"
F_IF_WHAT_REPLACES = "fldzDSZunkOeizxuA"
F_IF_CATEGORY      = "fldaEP7eIpU0zJkS8"
# Deal-specific
F_IF_DEAL_PRICE    = "fldqvoSR00fyA1XGn"
F_IF_REGULAR_PRICE = "fldcqvYClm5fMScaZ"
F_IF_DEAL_TYPE     = "fldAsY4xLTGxDt5SF"
F_IF_DEAL_EXPIRES  = "fldPFwWWk7WVq6Fcj"
F_IF_RISK          = "fldAo646uArtw4H2G"
F_IF_VENDOR_STATUS = "fldjaeF0zOeBPzyCP"
F_IF_CURRENT_COST  = "fldjfRn6dUDCwZYS5"

# APIs
F_A2_NAME          = "fldgEt7Po7CBXvA71"
F_A2_LINK          = "fld0SuLIJPIGM4UTY"
F_A2_ABOUT         = "fld6t5xv5ejuni3pI"
F_A2_DATE_FOUND    = "fldstJZi2oybRW4rj"
F_A2_DECISION      = "fldbpVmC9myu1dk0T"
F_A2_FREE_TIER     = "fldh0ShjqkmK66aM2"
F_A2_INT_POTENTIAL = "fldv71991pgCAkOpc"
F_A2_CLAUDE_PROMPT = "fldaTIRgoWcQcENj4"

# Stack & Platforms
F_SP_NAME     = "fldFBxTY9K1nBbt4W"
F_SP_CATEGORY = "fldY8K22GUDevl0RK"
F_SP_HOW_USE  = "fldDFtzRX4VuHNfPy"
F_SP_STATUS   = "fld26qWkoaARqWZfU"
F_SP_ACTIVE   = "fldBW4YyH9LackB0o"

# Tasks
F_T_TASK_NAME      = "fldRXiRmZFGPvWsXM"
F_T_STATUS         = "fldfOGLWCc1mcqLZ3"
F_T_PRIORITY       = "fldLUfo48cuUeuPE9"
F_T_ASSIGNED       = "fldm42lpYOGw8e1OT"
F_T_SOURCE         = "fld7NgeI1SvCsVN6L"
F_T_SOURCE_SECTION = "fldWDIe8Beo5U4Gls"
F_T_DATE_CREATED   = "fld69Jaayh5XU1g8S"
F_T_EFFORT         = "fldBfgaPjyLqd4Rvx"
F_T_DESCRIPTION    = "fldr07boWFbFqBO0i"
F_T_CLAUDE_PROMPT  = "fldZD6P5BLAIVemnx"
F_T_COST_IMPACT    = "fldunrBqIVfeT5H88"

# Routine Runs
F_RR_RUN_ID           = "fldE3XHs5kMzmkXZE"
F_RR_ROUTINE          = "fldvYQR47GKiVZDAi"
F_RR_DATE             = "fldyyp2az4d8LxgeM"
F_RR_STATUS           = "fld5bAyaKrrVy67wi"
F_RR_SUMMARY          = "fldv9IvELdrA2yKNR"
F_RR_SECTIONS         = "fld6zQhheLWKvf4so"
F_RR_ITEMS_FOUND      = "fldv1wrxybBDp9Duu"
F_RR_ACTION_CREATED   = "fld6wALQdztBLaBZE"
F_RR_COLLECTOR_STATUS = "fldyckNQ99uPfLldi"
F_RR_DURATION         = "fldRREFTHYZOzw03c"
F_RR_NOTES            = "fldg9aTPZbCkvxM8s"

# Logins & Keys
F_LK_NAME = "fldQqf8eF4mT2U0zT"
F_LK_KEYS = "fld4fYgMypJz9Iete"

# ──────────────────────────── API config ─────────────────────────────────

CLAUDE_MODEL   = "claude-haiku-4-5-20251001"
CLAUDE_URL     = "https://api.anthropic.com/v1/messages"
CLAUDE_VERSION = "2023-06-01"

GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_URL   = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
GEMINI_SLEEP = 4.5  # seconds between batch calls — stays inside free-tier 15 RPM

HYPEBASE_CONTEXT = (
    "HypeBase is a talent/entertainment data platform aggregating profiles of "
    "artists, athletes, actors, and companies across music, film/TV, and sports. "
    "Tech stack: Python scrapers on GitHub Actions (17+ repos under bwbcollier-byte), "
    "Supabase (main data store), Airtable (ops workflow), Slack (notifications), "
    "Next.js frontend, Claude Code for dev + scheduled AI routines. "
    "Key priorities: scraper reliability, reducing AI routine costs, adding new "
    "enrichment APIs (prefer free), improving data quality."
)

WINDOW_DAYS = 4   # look back this many days for collector-added items

# Decisions that require a Task + Claude Prompt
ACTIONABLE_DECISIONS = {
    "Adopt Now", "Prototype", "Act On", "Buy", "Trial",
    "Subscribe Free", "Evaluate Further",
}

# ──────────────────────────── Airtable helpers ───────────────────────────

def at_request(method, path, payload=None, api_key=None):
    """Single Airtable API call. Returns parsed JSON or raises."""
    url = f"https://api.airtable.com/v0/{path}"
    data = json.dumps(payload).encode() if payload else None
    req = request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"Airtable {method} {path} → HTTP {e.code}: {body}") from e


def at_list(table_id, formula, api_key):
    """List all matching records (auto-pages). formula may be empty string."""
    records = []
    offset = None
    while True:
        parts = [f"pageSize=100"]
        if formula:
            parts.append(f"filterByFormula={quote(formula)}")
        if offset:
            parts.append(f"offset={quote(offset)}")
        qs = "&".join(parts)
        resp = at_request("GET", f"{AIRTABLE_BASE}/{table_id}?{qs}", api_key=api_key)
        records.extend(resp.get("records", []))
        offset = resp.get("offset")
        if not offset:
            break
    return records


def at_update(table_id, updates, api_key):
    """Batch-update records in groups of 10."""
    for i in range(0, len(updates), 10):
        batch = updates[i:i + 10]
        at_request("PATCH", f"{AIRTABLE_BASE}/{table_id}",
                   {"records": batch, "typecast": True}, api_key)
        time.sleep(0.25)


def at_create(table_id, fields, api_key):
    """Create a single record. Returns created record dict."""
    return at_request("POST", f"{AIRTABLE_BASE}/{table_id}",
                      {"fields": fields, "typecast": True}, api_key)


# ──────────────────────────── Claude Haiku helper ────────────────────────

def claude_call(prompt, anthropic_key, max_tokens=2048):
    """Single Claude Haiku call. Returns text response or None on failure."""
    payload = {
        "model": CLAUDE_MODEL,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }
    data = json.dumps(payload).encode()
    req = request.Request(CLAUDE_URL, data=data, method="POST")
    req.add_header("x-api-key", anthropic_key)
    req.add_header("anthropic-version", CLAUDE_VERSION)
    req.add_header("content-type", "application/json")
    try:
        with request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            return result["content"][0]["text"]
    except Exception as e:
        print(f"  [claude] call failed: {e}", file=sys.stderr)
        return None


# ──────────────────────────── Gemini helper ──────────────────────────────

def gemini_call(prompt, gemini_key, json_mode=False):
    """Single Gemini call. Returns text response or None on failure."""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2},
    }
    if json_mode:
        payload["generationConfig"]["responseMimeType"] = "application/json"

    url = f"{GEMINI_URL}?key={gemini_key}"
    data = json.dumps(payload).encode()
    req = request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            return result["candidates"][0]["content"]["parts"][0]["text"]
    except error.HTTPError as e:
        body = e.read().decode(errors="replace")
        print(f"  [gemini] HTTP {e.code}: {body[:200]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [gemini] call failed: {e}", file=sys.stderr)
        return None


# ──────────────────────────── Key loading ────────────────────────────────

def load_slack_webhook():
    """Load TRIAGE_SLACK_WEBHOOK from env or ~/.claude/.env file."""
    val = os.environ.get("TRIAGE_SLACK_WEBHOOK", "").strip()
    if val:
        return val
    env_file = os.path.expanduser("~/.claude/.env")
    if os.path.exists(env_file):
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith("TRIAGE_SLACK_WEBHOOK="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def get_gemini_key(at_key):
    """Load Gemini key from Airtable Logins & Keys or GEMINI_API_KEY env var."""
    env_val = os.environ.get("GEMINI_API_KEY", "").strip()
    try:
        rows = at_list(TABLE_LOGINS_KEYS,
                       f'{{Name}}="Google Gemini"', at_key)
        if rows:
            key = rows[0]["fields"].get(F_LK_KEYS, "").strip()
            if key:
                return key
    except Exception:
        pass
    return env_val or None


# ──────────────────────────── Data fetching ──────────────────────────────

def fetch_actionable_items(at_key, since_date_str):
    """
    Fetch items that are actionable (have a decision worth acting on)
    and were found recently. Returns dict keyed by section name.
    """
    result = {
        "skills": [],
        "platform_updates": [],
        "ai_news": [],
        "deals": [],
        "apis": [],
    }

    # Skills — Recommended (Gemini pre-evaluated)
    try:
        rows = at_list(TABLE_SKILLS,
                       f'AND({{Type}}="Recommended",IS_AFTER({{Found By Routine}},"{since_date_str}"))',
                       at_key)
        result["skills"] = rows
        print(f"  Skills (Recommended): {len(rows)}")
    except Exception as e:
        print(f"  [warn] Skills fetch failed: {e}", file=sys.stderr)

    # Platform Updates — Adopt Now / Prototype / Watch
    try:
        rows = at_list(TABLE_INTEL_FEED,
                       f'AND({{Feed Type}}="Platform Update",'
                       f'OR({{Decision}}="Adopt Now",{{Decision}}="Prototype",{{Decision}}="Watch"),'
                       f'IS_AFTER({{Date Found}},"{since_date_str}"))',
                       at_key)
        result["platform_updates"] = rows
        print(f"  Platform Updates (actionable): {len(rows)}")
    except Exception as e:
        print(f"  [warn] Platform Updates fetch failed: {e}", file=sys.stderr)

    # AI News — Act On / Explore / Reference
    try:
        rows = at_list(TABLE_INTEL_FEED,
                       f'AND({{Feed Type}}="AI News",'
                       f'OR({{Decision}}="Act On",{{Decision}}="Explore",{{Decision}}="Reference"),'
                       f'IS_AFTER({{Date Found}},"{since_date_str}"))',
                       at_key)
        result["ai_news"] = rows
        print(f"  AI News (actionable): {len(rows)}")
    except Exception as e:
        print(f"  [warn] AI News fetch failed: {e}", file=sys.stderr)

    # Deals — any Pending (Gemini doesn't evaluate deals — we do it here)
    try:
        rows = at_list(TABLE_INTEL_FEED,
                       f'AND({{Feed Type}}="Deal",'
                       f'OR({{Decision}}="Pending",{{Decision}}=""),'
                       f'IS_AFTER({{Date Found}},"{since_date_str}"))',
                       at_key)
        result["deals"] = rows
        print(f"  Deals (Pending): {len(rows)}")
    except Exception as e:
        print(f"  [warn] Deals fetch failed: {e}", file=sys.stderr)

    # APIs — Pending (collector wrote them, not yet evaluated)
    try:
        rows = at_list(TABLE_APIS_V2,
                       f'AND(OR({{Decision}}="Pending",{{Decision}}=""),'
                       f'IS_AFTER({{Date Found}},"{since_date_str}"))',
                       at_key)
        result["apis"] = rows
        print(f"  APIs (Pending): {len(rows)}")
    except Exception as e:
        print(f"  [warn] APIs fetch failed: {e}", file=sys.stderr)

    return result


def fetch_existing_task_names(at_key):
    """Return set of Task Names currently New/In Progress/Blocked for dedup."""
    try:
        rows = at_list(TABLE_TASKS,
                       'AND({Source}="Strategic Intel",'
                       'OR({Status}="New",{Status}="In Progress",{Status}="Blocked"))',
                       at_key)
        return {r["fields"].get(F_T_TASK_NAME, "").lower() for r in rows}
    except Exception as e:
        print(f"  [warn] Tasks fetch failed (dedup disabled): {e}", file=sys.stderr)
        return set()


def fetch_stack(at_key):
    """Return compact stack summary string for grounding Claude Prompts."""
    try:
        rows = at_list(TABLE_STACK_PLATFORMS, '{Active}=1', at_key)
        lines = []
        for r in rows:
            f = r["fields"]
            name = f.get(F_SP_NAME, "")
            cat = f.get(F_SP_CATEGORY, "")
            how = f.get(F_SP_HOW_USE, "")
            if name:
                lines.append(f"- {name} ({cat}): {how}" if how else f"- {name} ({cat})")
        return "\n".join(lines[:30])  # cap to avoid token bloat
    except Exception as e:
        print(f"  [warn] Stack fetch failed: {e}", file=sys.stderr)
        return "(stack unavailable)"


def check_collector_freshness(at_key):
    """Return (status_string, is_fresh) based on most recent Date Found in Intel Feed."""
    try:
        rows = at_list(TABLE_INTEL_FEED,
                       'NOT({Date Found}="")',
                       at_key)
        if not rows:
            return "Missing", False
        # find most recent
        dates = []
        for r in rows:
            d = r["fields"].get(F_IF_DATE_FOUND, "")
            if d:
                dates.append(d)
        if not dates:
            return "Missing", False
        latest = max(dates)
        # parse YYYY-MM-DD
        latest_dt = datetime.strptime(latest[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
        age_hours = (datetime.now(timezone.utc) - latest_dt).total_seconds() / 3600
        status = f"Fresh ({int(age_hours)}h old)" if age_hours < 36 else f"Stale ({int(age_hours)}h old)"
        return status, age_hours < 36
    except Exception as e:
        return f"Unknown ({e})", False


# ──────────────────────────── Deal evaluation ────────────────────────────

def evaluate_deals(deals, gemini_key, at_key, today_str):
    """
    Use Gemini to evaluate pending Deal rows in batch.
    Writes Decision + enrichment fields back to Airtable.
    Returns list of evaluated deal dicts for the brief.
    """
    if not deals or not gemini_key:
        return []

    evaluated = []
    batch_size = 10

    for i in range(0, len(deals), batch_size):
        batch = deals[i:i + batch_size]
        items_json = json.dumps([
            {
                "id": r["id"],
                "title": r["fields"].get(F_IF_TITLE, ""),
                "summary": r["fields"].get(F_IF_SUMMARY, ""),
                "source": r["fields"].get(F_IF_SOURCE, ""),
                "category": r["fields"].get(F_IF_CATEGORY, ""),
            }
            for r in batch
        ])

        prompt = f"""You are evaluating software deals for HypeBase.

{HYPEBASE_CONTEXT}

RELEVANT CATEGORIES: AI, data, automation, developer tools, scraping, API management, monitoring, databases.
SKIP: consumer apps, gaming, weather, health, crypto, photography, education, finance (non-entertainment).

Deals to evaluate:
{items_json}

For each deal, return a JSON array where each element has:
- "id": the record id (unchanged)
- "decision": "Buy" | "Trial" | "Watch" | "Skip"
- "why": one sentence why (HypeBase-specific, or "Irrelevant category" for Skips)
- "vendor_status": "Established" | "Growing" | "Early Stage" | "Unknown"
- "risk": one sentence risk assessment (or empty string for Skips)

Return ONLY the JSON array, no markdown fences."""

        resp = gemini_call(prompt, gemini_key, json_mode=True)
        if not resp:
            continue

        try:
            resp_clean = resp.strip()
            if resp_clean.startswith("```"):
                resp_clean = resp_clean.split("\n", 1)[1].rsplit("```", 1)[0]
            evals = json.loads(resp_clean)
        except Exception as e:
            print(f"  [deals] JSON parse failed: {e}", file=sys.stderr)
            continue

        updates = []
        for ev in evals:
            rec_id = ev.get("id")
            decision = ev.get("decision", "Skip")
            why = ev.get("why", "")
            risk = ev.get("risk", "")
            vendor_status = ev.get("vendor_status", "Unknown")

            updates.append({
                "id": rec_id,
                "fields": {
                    F_IF_DECISION: decision,
                    F_IF_WHY: why,
                    F_IF_RISK: risk,
                    F_IF_VENDOR_STATUS: vendor_status,
                    F_IF_NOTES: f"Auto-evaluated by Gemini {today_str}",
                },
            })

            if decision in ("Buy", "Trial", "Watch"):
                # find original row for brief
                orig = next((r for r in batch if r["id"] == rec_id), None)
                if orig:
                    orig["fields"][F_IF_DECISION] = decision
                    orig["fields"][F_IF_WHY] = why
                    orig["fields"][F_IF_RISK] = risk
                    orig["fields"][F_IF_VENDOR_STATUS] = vendor_status
                    evaluated.append(orig)

        if updates:
            at_update(TABLE_INTEL_FEED, updates, at_key)
        time.sleep(GEMINI_SLEEP)

    return evaluated


# ──────────────────────────── API evaluation ─────────────────────────────

def evaluate_apis(apis, gemini_key, at_key, today_str):
    """
    Use Gemini to evaluate pending API rows in batch.
    Writes Decision + Integration Potential back to Airtable.
    Returns list of subscribe-worthy API dicts for the brief.
    """
    if not apis or not gemini_key:
        return []

    evaluated = []
    batch_size = 10

    # Relevant category prefixes (embedded in About field as [Cat] prefix)
    RELEVANT_CATS = {
        "music", "video", "movies", "entertainment", "sports", "social",
        "news", "calendar", "games", "business", "data", "open data", "jobs",
    }

    # Pre-filter irrelevant categories
    relevant = []
    skip_ids = []
    for r in apis:
        about = r["fields"].get(F_A2_ABOUT, "").lower()
        # Extract [Cat] prefix if present
        cat = ""
        if about.startswith("["):
            end = about.find("]")
            if end > 0:
                cat = about[1:end].lower()
        if any(rc in cat for rc in RELEVANT_CATS) or not cat:
            relevant.append(r)
        else:
            skip_ids.append(r["id"])

    # Bulk-skip irrelevant
    if skip_ids:
        updates = [{"id": rid, "fields": {
            F_A2_DECISION: "Skip",
            F_A2_ABOUT: (next(r["fields"].get(F_A2_ABOUT, "") for r in apis if r["id"] == rid)),
        }} for rid in skip_ids]
        at_update(TABLE_APIS_V2, updates, at_key)
        print(f"  APIs bulk-skipped (irrelevant category): {len(skip_ids)}")

    if not relevant:
        return []

    for i in range(0, len(relevant), batch_size):
        batch = relevant[i:i + batch_size]
        items_json = json.dumps([
            {
                "id": r["id"],
                "name": r["fields"].get(F_A2_NAME, ""),
                "about": r["fields"].get(F_A2_ABOUT, "")[:300],
                "free_tier": r["fields"].get(F_A2_FREE_TIER, ""),
                "link": r["fields"].get(F_A2_LINK, ""),
            }
            for r in batch
        ])

        prompt = f"""You are evaluating APIs for HypeBase.

{HYPEBASE_CONTEXT}

APIs to evaluate:
{items_json}

For each API return a JSON array where each element has:
- "id": the record id (unchanged)
- "decision": "Subscribe Free" | "Evaluate Further" | "Skip"
  (Subscribe Free = has a useful free tier worth trying; Evaluate Further = paid but worth investigating; Skip = not useful for us)
- "integration_potential": one sentence on where in our pipeline this could be used (or "Not relevant" for Skips)

Return ONLY the JSON array, no markdown fences."""

        resp = gemini_call(prompt, gemini_key, json_mode=True)
        if not resp:
            continue

        try:
            resp_clean = resp.strip()
            if resp_clean.startswith("```"):
                resp_clean = resp_clean.split("\n", 1)[1].rsplit("```", 1)[0]
            evals = json.loads(resp_clean)
        except Exception as e:
            print(f"  [apis] JSON parse failed: {e}", file=sys.stderr)
            continue

        updates = []
        for ev in evals:
            rec_id = ev.get("id")
            decision = ev.get("decision", "Skip")
            potential = ev.get("integration_potential", "")

            updates.append({
                "id": rec_id,
                "fields": {
                    F_A2_DECISION: decision,
                    F_A2_INT_POTENTIAL: potential,
                },
            })

            if decision in ("Subscribe Free", "Evaluate Further"):
                orig = next((r for r in batch if r["id"] == rec_id), None)
                if orig:
                    orig["fields"][F_A2_DECISION] = decision
                    orig["fields"][F_A2_INT_POTENTIAL] = potential
                    evaluated.append(orig)

        if updates:
            at_update(TABLE_APIS_V2, updates, at_key)
        time.sleep(GEMINI_SLEEP)

    return evaluated


# ──────────────────────────── Claude Prompt + Task creation ──────────────

def generate_claude_prompts_and_tasks(
    actionable_items, at_key, anthropic_key, today_str, existing_task_names
):
    """
    For each actionable item, use Claude Haiku to generate:
    - A self-contained Claude Prompt (written to the source record)
    - A Task row in Airtable

    actionable_items: list of dicts with keys:
      table, rec_id, prompt_field, section, title, description, decision, effort, priority

    Returns count of Tasks created.
    """
    if not actionable_items or not anthropic_key:
        return 0

    tasks_created = 0

    # Batch all items into ONE Claude call for efficiency
    items_json = json.dumps([
        {
            "idx": i,
            "section": item["section"],
            "title": item["title"],
            "description": item.get("description", ""),
            "decision": item["decision"],
            "effort": item.get("effort", "M"),
        }
        for i, item in enumerate(actionable_items)
    ])

    prompt = f"""You are a technical operations assistant for HypeBase.

{HYPEBASE_CONTEXT}

Your task: for each item below, write:
1. A self-contained Claude Prompt that a fresh Claude Code session (with no memory of our setup) can execute.
2. A short Task description (1-2 sentences) summarising what to do and why.
3. A one-line Task Name in imperative form (e.g. "Integrate MusicBrainz API into yl-hb-mb scraper").

Claude Prompt format rules:
- ALWAYS open with exactly: "First, read /Users/ben/Documents/Claude OS/Work/Engineering Ops/prompts/hypebase-primer.md for project context. Then:"
- After that, spell out: what to fetch/build, specific files or repos (use bwbcollier-byte/<repo> format), constraints, done criteria.
- Reference the source Airtable record where relevant.
- Never use vague instructions like "replicate our setup" — define everything inline.
- For skills: explain how to install the Claude Code skill and test it.
- For APIs: explain how to add the integration to the relevant scraper repo, test with a curl command first.
- For platform updates / AI news: explain the code change needed and where to find the relevant file.

Items to process:
{items_json}

Return a JSON array where each element has:
- "idx": the index (unchanged)
- "task_name": imperative one-liner
- "task_description": 1-2 sentence summary
- "claude_prompt": the full self-contained prompt

Return ONLY the JSON array, no markdown fences or explanation."""

    resp = claude_call(prompt, anthropic_key, max_tokens=4096)
    if not resp:
        print("  [claude] batch prompt generation failed — skipping Task creation", file=sys.stderr)
        return 0

    try:
        resp_clean = resp.strip()
        if resp_clean.startswith("```"):
            resp_clean = resp_clean.split("\n", 1)[1].rsplit("```", 1)[0]
        outputs = json.loads(resp_clean)
    except Exception as e:
        print(f"  [claude] JSON parse failed: {e}", file=sys.stderr)
        return 0

    for out in outputs:
        idx = out.get("idx")
        if idx is None or idx >= len(actionable_items):
            continue

        item = actionable_items[idx]
        task_name = out.get("task_name", item["title"])[:255]
        task_desc = out.get("task_description", "")
        claude_prompt = out.get("claude_prompt", "")

        # Write Claude Prompt back to source record
        if item.get("prompt_field") and claude_prompt:
            try:
                at_update(item["table"], [{
                    "id": item["rec_id"],
                    "fields": {item["prompt_field"]: claude_prompt},
                }], at_key)
            except Exception as e:
                print(f"  [warn] Claude Prompt write failed for {item['rec_id']}: {e}", file=sys.stderr)

        # Create Task (skip if already in pipeline)
        if task_name.lower() in existing_task_names:
            print(f"  [skip] Task already in pipeline: {task_name[:60]}")
            continue

        priority_map = {
            "Adopt Now": "P2 - High", "Act On": "P2 - High", "Buy": "P2 - High",
            "Prototype": "P3 - Medium", "Trial": "P3 - Medium",
            "Subscribe Free": "P3 - Medium", "Evaluate Further": "P4 - Low",
        }
        priority = priority_map.get(item["decision"], "P3 - Medium")
        effort = item.get("effort", "M")
        if effort not in ("S", "M", "L", "XL"):
            effort = "M"

        try:
            at_create(TABLE_TASKS, {
                F_T_TASK_NAME:      task_name,
                F_T_STATUS:         "New",
                F_T_PRIORITY:       priority,
                F_T_ASSIGNED:       "Claude Ops",
                F_T_SOURCE:         "Strategic Intel",
                F_T_SOURCE_SECTION: item["section"],
                F_T_DATE_CREATED:   today_str,
                F_T_EFFORT:         effort,
                F_T_DESCRIPTION:    f"{task_desc}\n\nSource: {item['table']} rec {item['rec_id']}",
                F_T_CLAUDE_PROMPT:  claude_prompt,
                F_T_COST_IMPACT:    "Unknown",
            }, at_key)
            tasks_created += 1
            existing_task_names.add(task_name.lower())
            print(f"  ✓ Task created: {task_name[:70]}")
        except Exception as e:
            print(f"  [warn] Task create failed: {e}", file=sys.stderr)

    return tasks_created


# ──────────────────────────── Brief composition ──────────────────────────

def compose_brief(sections, gemini_key, today_label, tasks_created, stats):
    """Use Gemini to compose the Slack brief text from section summaries."""
    if not gemini_key:
        return _fallback_brief(sections, today_label, tasks_created, stats)

    # Build a compact data dump for Gemini
    lines = [
        f"Today: {today_label}",
        f"Tasks created this run: {tasks_created}",
        "",
        "=== SKILLS ===",
    ]
    for r in sections.get("skills", [])[:5]:
        f = r["fields"]
        lines.append(f"- {f.get(F_S_NAME, '?')} | Relevance: {f.get(F_S_RELEVANCE, '?')} | Effort: {f.get(F_S_EFFORT, '?')} | {f.get(F_S_AUDIT_NOTES, '')[:120]}")

    lines += ["", "=== PLATFORM UPDATES ==="]
    for r in sections.get("platform_updates", [])[:5]:
        f = r["fields"]
        lines.append(f"- [{f.get(F_IF_DECISION,'?')}] {f.get(F_IF_TITLE,'?')} ({f.get(F_IF_SOURCE,'?')}) | {f.get(F_IF_WHY,'')[:150]}")

    lines += ["", "=== AI NEWS ==="]
    for r in sections.get("ai_news", [])[:5]:
        f = r["fields"]
        lines.append(f"- [{f.get(F_IF_DECISION,'?')}] {f.get(F_IF_TITLE,'?')} | {f.get(F_IF_WHY,'')[:150]}")

    lines += ["", "=== DEALS ==="]
    for r in sections.get("evaluated_deals", [])[:3]:
        f = r["fields"]
        lines.append(f"- [{f.get(F_IF_DECISION,'?')}] {f.get(F_IF_TITLE,'?')} | {f.get(F_IF_WHY,'')[:120]} | Risk: {f.get(F_IF_RISK,'?')[:80]}")

    lines += ["", "=== APIs ==="]
    for r in sections.get("evaluated_apis", [])[:5]:
        f = r["fields"]
        lines.append(f"- [{f.get(F_A2_DECISION,'?')}] {f.get(F_A2_NAME,'?')} | {f.get(F_A2_INT_POTENTIAL,'')[:120]}")

    data_dump = "\n".join(lines)

    prompt = f"""You are writing a strategic intelligence brief for HypeBase (a talent/entertainment data platform).

Here is the data from this run:
{data_dump}

Write a concise Slack brief in this exact format (use plain text, no markdown headers with #):

*Strategic Intelligence Brief — {today_label}*

*📊 Brief Summary*
• Skills: X new recommended
• Platform Updates: X reviewed • X Adopt Now / X Prototype / X Watch
• AI News: X relevant items
• Deals: X worth considering
• APIs: X subscribe-worthy
• Action Items created: {tasks_created}

*📋 Action Items*
List any Act On / Adopt Now / Buy / Trial items as: N. [Action] — [Section] — [Effort]

*🛠️ Skills*
Top 2-3 recommended skills with name, relevance score, and one-line reason.

*🔄 Platform Updates*
Top 2-3 updates worth acting on with summary and use case.

*📰 AI News*
Top 2-3 news items with summary and HypeBase relevance.

*💰 Deals*
Any Buy/Trial/Watch deals with deal details and fit.

*🔌 APIs*
Top 2-3 subscribe-worthy APIs with integration point.

Keep it scannable. Each item is 1-2 lines max. Total brief should be under 2500 characters.
Return only the brief text, nothing else."""

    resp = gemini_call(prompt, gemini_key)
    if resp:
        return resp
    return _fallback_brief(sections, today_label, tasks_created, stats)


def _fallback_brief(sections, today_label, tasks_created, stats):
    """Minimal brief when Gemini is unavailable."""
    lines = [
        f"*Strategic Intelligence Brief — {today_label}*",
        "",
        "*📊 Brief Summary*",
        f"• Skills: {len(sections.get('skills', []))} new recommended",
        f"• Platform Updates: {len(sections.get('platform_updates', []))} actionable",
        f"• AI News: {len(sections.get('ai_news', []))} relevant",
        f"• Deals: {len(sections.get('evaluated_deals', []))} evaluated",
        f"• APIs: {len(sections.get('evaluated_apis', []))} subscribe-worthy",
        f"• Action Items created: {tasks_created}",
        "",
        "_(Gemini unavailable — full brief skipped. Check Airtable for details.)_",
    ]
    return "\n".join(lines)


# ──────────────────────────── Slack posting ──────────────────────────────

def post_slack(text, webhook_url):
    """Post a plain-text message to Slack via incoming webhook. Returns True on success."""
    payload = {"text": text}
    data = json.dumps(payload).encode()
    req = request.Request(webhook_url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    for attempt in range(2):
        try:
            with request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode()
                if body == "ok":
                    return True
                print(f"  [slack] unexpected response: {body}", file=sys.stderr)
                return False
        except Exception as e:
            print(f"  [slack] attempt {attempt + 1} failed: {e}", file=sys.stderr)
            if attempt == 0:
                time.sleep(10)
    return False


# ──────────────────────────── Routine run logging ────────────────────────

def log_run(at_key, run_id, status, summary, sections_covered,
            items_found, tasks_created, collector_status, duration_s, notes=""):
    """Write one row to Routine Runs."""
    try:
        at_create(TABLE_ROUTINE_RUNS, {
            F_RR_RUN_ID:           run_id,
            F_RR_ROUTINE:          "Strategic Intel",
            F_RR_DATE:             run_id.split("-")[1] + "-" + run_id.split("-")[2] + "-" + run_id.split("-")[3],
            F_RR_STATUS:           status,
            F_RR_SUMMARY:          summary,
            F_RR_SECTIONS:         sections_covered,
            F_RR_ITEMS_FOUND:      items_found,
            F_RR_ACTION_CREATED:   tasks_created,
            F_RR_COLLECTOR_STATUS: collector_status,
            F_RR_DURATION:         f"{int(duration_s)}s",
            F_RR_NOTES:            notes,
        }, at_key)
    except Exception as e:
        print(f"  [warn] Routine Runs log failed: {e}", file=sys.stderr)


# ──────────────────────────── Main ───────────────────────────────────────

def main():
    start = __import__("time").time()

    at_key = os.environ.get("AIRTABLE_API_KEY", "").strip()
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not at_key:
        print("FATAL: AIRTABLE_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    if not anthropic_key:
        print("FATAL: ANTHROPIC_API_KEY not set", file=sys.stderr)
        sys.exit(1)

    slack_webhook = load_slack_webhook()
    gemini_key = get_gemini_key(at_key)

    # Sydney timezone offset (+10 AEST / +11 AEDT) — approximate with UTC+10
    sydney_offset = timezone(timedelta(hours=10))
    now_sydney = datetime.now(sydney_offset)
    today_str = now_sydney.strftime("%Y-%m-%d")
    today_label = now_sydney.strftime("%A, %d %B %Y")
    run_id = f"intel-{now_sydney.strftime('%Y-%m-%d-%H%M')}"
    since_date = (now_sydney - timedelta(days=WINDOW_DAYS)).strftime("%Y-%m-%d")

    print(f"\n=== Intel Brief {run_id} ===")
    print(f"Window: last {WINDOW_DAYS} days (since {since_date})")

    # ── Step 0: Pre-flight ─────────────────────────────────────────────────
    print("\n[0] Pre-flight checks")
    try:
        at_request("GET", f"{AIRTABLE_BASE}/{TABLE_INTEL_FEED}?maxRecords=1", api_key=at_key)
        print("  Airtable: OK")
    except Exception as e:
        msg = f"Airtable unreachable: {e}"
        print(f"  FAIL: {msg}", file=sys.stderr)
        if slack_webhook:
            post_slack(f"⚠️ Intel brief skipped {today_str}: {msg}", slack_webhook)
        log_run(at_key, run_id, "Failed", msg, [], 0, 0, "Unknown",
                __import__("time").time() - start, msg)
        sys.exit(1)

    if not slack_webhook:
        print("  [warn] TRIAGE_SLACK_WEBHOOK not set — brief will not be posted")

    collector_status, collector_fresh = check_collector_freshness(at_key)
    print(f"  Collector: {collector_status}")

    # ── Step 1: Fetch data ─────────────────────────────────────────────────
    print("\n[1] Fetching data")
    items = fetch_actionable_items(at_key, since_date)
    existing_tasks = fetch_existing_task_names(at_key)
    stack_summary = fetch_stack(at_key)
    print(f"  Existing pipeline tasks: {len(existing_tasks)}")

    total_items = sum(len(v) for v in items.values())
    print(f"  Total items to process: {total_items}")

    if total_items == 0 and collector_fresh:
        msg = f"No new items in last {WINDOW_DAYS} days — nothing to brief."
        print(f"\n{msg}")
        if slack_webhook:
            post_slack(f"*Intel Brief {today_label}*\n_{msg}_", slack_webhook)
        log_run(at_key, run_id, "Skipped", msg, [], 0, 0, collector_status,
                __import__("time").time() - start)
        return

    # ── Step 2: Evaluate Deals ────────────────────────────────────────────
    evaluated_deals = []
    if items["deals"]:
        print(f"\n[2] Evaluating {len(items['deals'])} deals via Gemini")
        evaluated_deals = evaluate_deals(items["deals"], gemini_key, at_key, today_str)
        print(f"  Worth actioning: {len(evaluated_deals)}")

    # ── Step 3: Evaluate APIs ─────────────────────────────────────────────
    evaluated_apis = []
    if items["apis"]:
        print(f"\n[3] Evaluating {len(items['apis'])} APIs via Gemini")
        evaluated_apis = evaluate_apis(items["apis"], gemini_key, at_key, today_str)
        print(f"  Subscribe-worthy: {len(evaluated_apis)}")

    # ── Step 4: Build actionable items list for Claude ────────────────────
    print("\n[4] Building actionable items for Claude Haiku")
    actionable = []

    # Skills (Recommended)
    for r in items["skills"]:
        f = r["fields"]
        if not f.get(F_S_CLAUDE_PROMPT):  # only those missing a prompt
            actionable.append({
                "table": TABLE_SKILLS,
                "rec_id": r["id"],
                "prompt_field": F_S_CLAUDE_PROMPT,
                "section": "Skills",
                "title": f.get(F_S_NAME, ""),
                "description": f"{f.get(F_S_DESC, '')} | Relevance: {f.get(F_S_RELEVANCE, '')} | {f.get(F_S_AUDIT_NOTES, '')}",
                "decision": "Adopt Now",
                "effort": f.get(F_S_EFFORT, "M"),
            })

    # Platform Updates (Adopt Now / Prototype only)
    for r in items["platform_updates"]:
        f = r["fields"]
        dec = f.get(F_IF_DECISION, "")
        if dec in ("Adopt Now", "Prototype") and not f.get(F_IF_CLAUDE_PROMPT):
            actionable.append({
                "table": TABLE_INTEL_FEED,
                "rec_id": r["id"],
                "prompt_field": F_IF_CLAUDE_PROMPT,
                "section": "Platform Updates",
                "title": f.get(F_IF_TITLE, ""),
                "description": f"{f.get(F_IF_WHY, '')} | {f.get(F_IF_USE_CASE_1, '')}",
                "decision": dec,
                "effort": f.get(F_IF_EFFORT, "M"),
            })

    # AI News (Act On only)
    for r in items["ai_news"]:
        f = r["fields"]
        dec = f.get(F_IF_DECISION, "")
        if dec == "Act On" and not f.get(F_IF_CLAUDE_PROMPT):
            actionable.append({
                "table": TABLE_INTEL_FEED,
                "rec_id": r["id"],
                "prompt_field": F_IF_CLAUDE_PROMPT,
                "section": "AI News",
                "title": f.get(F_IF_TITLE, ""),
                "description": f"{f.get(F_IF_WHY, '')} | {f.get(F_IF_USE_CASE_1, '')}",
                "decision": dec,
                "effort": f.get(F_IF_EFFORT, "M"),
            })

    # Deals (Buy / Trial)
    for r in evaluated_deals:
        f = r["fields"]
        dec = f.get(F_IF_DECISION, "")
        if dec in ("Buy", "Trial"):
            actionable.append({
                "table": TABLE_INTEL_FEED,
                "rec_id": r["id"],
                "prompt_field": F_IF_CLAUDE_PROMPT,
                "section": "Deals",
                "title": f.get(F_IF_TITLE, ""),
                "description": f"{f.get(F_IF_WHY, '')} | Risk: {f.get(F_IF_RISK, '')}",
                "decision": dec,
                "effort": "S",
            })

    # APIs (Subscribe Free / Evaluate Further)
    for r in evaluated_apis:
        f = r["fields"]
        dec = f.get(F_A2_DECISION, "")
        actionable.append({
            "table": TABLE_APIS_V2,
            "rec_id": r["id"],
            "prompt_field": F_A2_CLAUDE_PROMPT,
            "section": "APIs",
            "title": f.get(F_A2_NAME, ""),
            "description": f"{f.get(F_A2_INT_POTENTIAL, '')} | Free tier: {f.get(F_A2_FREE_TIER, '')}",
            "decision": dec,
            "effort": "S",
        })

    print(f"  Actionable items requiring Claude Prompts: {len(actionable)}")

    # ── Step 5: Generate Claude Prompts + Tasks ────────────────────────────
    tasks_created = 0
    if actionable:
        print(f"\n[5] Generating Claude Prompts + Tasks via Claude Haiku")
        tasks_created = generate_claude_prompts_and_tasks(
            actionable, at_key, anthropic_key, today_str, existing_tasks
        )
        print(f"  Tasks created: {tasks_created}")
    else:
        print("\n[5] No actionable items — skipping Claude Haiku call")

    # ── Step 6: Compose and post brief ────────────────────────────────────
    print("\n[6] Composing Slack brief via Gemini")
    sections_for_brief = {
        "skills": items["skills"],
        "platform_updates": items["platform_updates"],
        "ai_news": items["ai_news"],
        "evaluated_deals": evaluated_deals,
        "evaluated_apis": evaluated_apis,
    }
    stats = {
        "total_items": total_items,
        "tasks_created": tasks_created,
        "collector_status": collector_status,
    }
    brief_text = compose_brief(sections_for_brief, gemini_key, today_label, tasks_created, stats)

    # Append collector warning if stale
    if not collector_fresh:
        brief_text += f"\n\n⚠️ _Collector data may be stale ({collector_status}) — some sections may be incomplete._"

    print(f"  Brief length: {len(brief_text)} chars")

    slack_ok = False
    if slack_webhook:
        print("  Posting to Slack...")
        slack_ok = post_slack(brief_text, slack_webhook)
        print(f"  Slack: {'OK' if slack_ok else 'FAILED'}")
    else:
        print("  [skip] No Slack webhook configured")

    # ── Step 7: Log run ────────────────────────────────────────────────────
    duration = __import__("time").time() - start
    sections_covered = []
    if items["skills"]:         sections_covered.append("Skills")
    if items["platform_updates"]: sections_covered.append("Platform Updates")
    if items["ai_news"]:        sections_covered.append("AI News")
    if items["deals"]:          sections_covered.append("Deals")
    if items["apis"]:           sections_covered.append("APIs")

    summary = (
        f"{total_items} items across {len(sections_covered)} sections, "
        f"{tasks_created} Tasks created"
    )
    status = "Completed" if slack_ok or not slack_webhook else "Partial"
    notes = "" if slack_ok else "Slack post failed"

    print(f"\n[7] Logging run: {status} — {summary}")
    log_run(at_key, run_id, status, summary, sections_covered,
            total_items, tasks_created, collector_status, duration, notes)

    print(f"\n=== Done in {int(duration)}s ===\n")


if __name__ == "__main__":
    main()
