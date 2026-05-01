#!/usr/bin/env python3
"""
PK Review — runs daily via GitHub Actions.

Fetches the oldest Draft records from pk_assets (Airtable), runs a Gemini
triage pass to classify each as PASS / FIXABLE / UNFIXABLE / WAITING, then
uses the Anthropic Message Batches API (Haiku) to auto-fix FIXABLE records.
Posts a Slack summary on completion.

Stdlib only. No third-party deps.

Env vars required:
  AIRTABLE_API_KEY     PAT with access to pk_assets (appbUpVCXkuPCOo6y)
                       and rco_admin (app6biS7yjV6XzFVG) for Gemini key lookup
  ANTHROPIC_API_KEY    For Claude Haiku message batches
  GEMINI_API_KEY       Fallback if Credentials table lookup fails
  TRIAGE_SLACK_WEBHOOK Incoming webhook URL
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib import request, error
from urllib.parse import urlencode

# ---------- pk_assets Airtable ----------

PK_BASE  = "appbUpVCXkuPCOo6y"
PK_TABLE = "tblKkKRKRsd7IkqHm"

F_NAME         = "fldYb4DpOA6hNTgYh"
F_DESCRIPTION  = "fld5YVhf3YEgvyo2j"
F_PROMPT_TEXT  = "fldJfx71qA76Z6bJE"
F_CODE_REACT   = "fldWLYeGvIbKq9yK0"
F_CODE_HTML    = "fldMfa1ePnUo2panh"
F_TAGS         = "fldZNayFgYr4NmtZM"
F_CATEGORY     = "fldq1pnoEPOF2GsLq"
F_STYLE        = "fldpfRXUCyOmxcTxv"
F_TIER         = "fldvxJOHaIurQrXQo"
F_PUBLISHED    = "fldu6soOkw6VTD9jg"
F_SOURCE       = "fldSG3VSf6J2Z1gNC"
F_SOURCE_URL   = "fldAEdgO8lDRYhjoQ"
F_REVIEW_NOTES = "fldA4VkbcnH2BTUbc"

# ---------- rco_admin Credentials (for Gemini key lookup) ----------

RCO_BASE     = "app6biS7yjV6XzFVG"
TABLE_CREDS  = "tblvBr6RIc7bcGXYJ"
F_CRED_VALUE = "fldGMbEDOCtLXqbLX"

# ---------- Config ----------

PREVIEW_BASE        = "https://pk-preview.yunikonlabs-co.workers.dev"
BATCH_SIZE          = 30
CLAUDE_MODEL        = "claude-haiku-4-5-20251001"
GEMINI_MODEL        = "gemini-2.5-flash-lite"
GEMINI_URL          = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
ANTHROPIC_BATCH_URL = "https://api.anthropic.com/v1/messages/batches"
ANTHROPIC_VERSION   = "2023-06-01"
BATCH_POLL_INTERVAL = 30    # seconds between polls
BATCH_TIMEOUT       = 900   # 15 minutes max wait
AT_SLEEP            = 0.25  # polite delay between Airtable calls


# ---------- HTTP helper ----------

def http(url, method="GET", headers=None, body=None, timeout=30):
    headers = headers or {}
    data = json.dumps(body).encode() if body is not None else None
    if data and "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except error.HTTPError as e:
        return e.code, e.read()
    except error.URLError as e:
        return 0, str(e).encode()


# ---------- Airtable helpers ----------

def at_list_records(base, table, at_key, filter_formula=None, fields=None, max_records=None):
    """Fetch records from Airtable with optional filter and field selection."""
    headers = {"Authorization": f"Bearer {at_key}"}
    records = []
    offset = None
    while True:
        params = {}
        if filter_formula:
            params["filterByFormula"] = filter_formula
        if fields:
            for i, f in enumerate(fields):
                params[f"fields[{i}]"] = f
        if offset:
            params["offset"] = offset
        page_size = 100
        if max_records:
            remaining = max_records - len(records)
            if remaining <= 0:
                break
            page_size = min(remaining, 100)
        params["pageSize"] = page_size
        url = f"https://api.airtable.com/v0/{base}/{table}"
        if params:
            url += "?" + urlencode(params)
        status, body = http(url, headers=headers)
        if status >= 400:
            print(f"WARN airtable list {table}: {status} {body[:200]!r}", file=sys.stderr)
            break
        data = json.loads(body)
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset or (max_records and len(records) >= max_records):
            break
        time.sleep(AT_SLEEP)
    return records[:max_records] if max_records else records


def at_update_records(base, table, updates, at_key):
    """PATCH a list of {id, fields} dicts in batches of 10."""
    if not updates:
        return 0
    headers = {"Authorization": f"Bearer {at_key}", "Content-Type": "application/json"}
    url = f"https://api.airtable.com/v0/{base}/{table}"
    done = 0
    for i in range(0, len(updates), 10):
        payload = {"records": updates[i:i + 10], "typecast": True}
        status, body = http(url, method="PATCH", headers=headers, body=payload)
        if status >= 400:
            print(f"WARN airtable update {table}: {status} {body[:300]!r}", file=sys.stderr)
            continue
        done += len(json.loads(body).get("records", []))
        time.sleep(AT_SLEEP)
    return done


# ---------- Gemini key ----------

def get_gemini_key(at_key):
    """Load a Gemini API key from rco_admin Credentials table, or env var fallback."""
    try:
        rows = at_list_records(RCO_BASE, TABLE_CREDS, at_key, fields=[F_CRED_VALUE])
        for r in rows:
            val = (r.get("fields", {}).get(F_CRED_VALUE) or "").strip()
            if val.startswith("AIzaSy"):
                return val
    except Exception as e:
        print(f"WARN gemini key lookup: {e}", file=sys.stderr)
    env_key = (os.environ.get("GEMINI_API_KEY") or "").strip()
    return env_key or None


# ---------- Preview check ----------

def fetch_preview(record_id):
    """
    Fetch the preview URL for a record.
    Returns (http_status: int, has_content: bool).
    has_content is False when the Worker returns the empty-state page.
    """
    url = f"{PREVIEW_BASE}/{record_id}"
    status, body = http(url, timeout=15)
    if status != 200:
        return status, False
    html = body.decode("utf-8", errors="replace")
    has_content = "No preview yet" not in html and len(html.strip()) > 300
    return status, has_content


# ---------- Local structural analysis ----------

def analyze_record(record, preview_status, preview_has_content):
    """
    Extract quick structural signals from a record without calling any LLM.
    These signals feed the Gemini triage prompt so Gemini doesn't need to
    read full code — it just reads the compact signals + the description text.
    """
    f = record.get("fields", {})
    code_html  = f.get(F_CODE_HTML)  or ""
    code_react = f.get(F_CODE_REACT) or ""
    desc       = f.get(F_DESCRIPTION) or ""

    dark_count       = code_html.count("dark:")
    responsive_count = sum(code_html.count(f"{bp}:") for bp in ["sm", "md", "lg"])
    has_hardcoded    = bool(re.search(
        r'(?:bg|text|border|fill|stroke)-\[#|style=["\'].*?color\s*:',
        code_html
    ))
    desc_word_count    = len(desc.split())
    desc_mentions_src  = bool(re.search(
        r'magic\s*ui|21st\.dev|hyperui|from the|originally|open.?source library',
        desc, re.IGNORECASE
    ))

    return {
        "id":                   record["id"],
        "name":                 f.get(F_NAME, ""),
        "description":          desc,
        "has_code_html":        bool(code_html.strip()),
        "has_code_react":       bool(code_react.strip()),
        "preview_status":       preview_status,
        "preview_has_content":  preview_has_content,
        "dark_mode_count":      dark_count,
        "responsive_count":     responsive_count,
        "has_hardcoded_colors": has_hardcoded,
        "desc_word_count":      desc_word_count,
        "desc_mentions_source": desc_mentions_src,
    }


# ---------- Gemini triage ----------

_GEMINI_TRIAGE_PROMPT = """You are a UI component quality reviewer for a marketplace called PromptKit.

Classify each component record as one of: PASS, FIXABLE, UNFIXABLE, WAITING.

WAITING  — Code HTML is missing (has_code_html=false) OR preview didn't load
           (preview_status != 200 OR preview_has_content=false).
           Do NOT attempt to fix. Leave as Draft.

UNFIXABLE — Code has obvious bugs, missing external dependencies that can't be
            inlined, or logic errors requiring the original author. Flag with a
            short review_notes explaining why.

FIXABLE — Specific issues that CAN be programmatically fixed:
          • dark_mode_count < 3  →  missing or insufficient dark: Tailwind variants
          • responsive_count < 2  →  missing responsive breakpoints (sm: md: lg:)
          • has_hardcoded_colors: true  →  bg-[#xxx] or inline style colors
          • desc_word_count < 15 OR desc_mentions_source: true  →  weak/bad description

PASS — Meets all criteria. No changes needed.

For FIXABLE: list each specific issue as a concise string in the "issues" array.
For UNFIXABLE: write 1–2 sentences in "review_notes".
For PASS / WAITING: empty arrays / strings.

Return ONLY a raw JSON array (no markdown fences, no explanation):
[{"id":"recXXX","classification":"PASS","issues":[],"review_notes":""},...]

Records:
"""


def gemini_triage(analyses, gemini_key):
    """
    Send all record analyses to Gemini for classification.
    Returns list of {id, classification, issues, review_notes} dicts.
    """
    prompt = _GEMINI_TRIAGE_PROMPT + json.dumps(analyses, indent=2)
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 8192},
    }
    status, body = http(f"{GEMINI_URL}?key={gemini_key}", method="POST", body=payload)
    if status != 200:
        print(f"WARN gemini triage: HTTP {status} {body[:300]!r}", file=sys.stderr)
        return []
    try:
        resp    = json.loads(body)
        content = resp["candidates"][0]["content"]["parts"][0]["text"].strip()
        if content.startswith("```"):
            parts   = content.split("```")
            content = parts[1] if len(parts) > 1 else content
            if content.lower().startswith("json\n"):
                content = content[5:]
            content = content.strip()
        return json.loads(content)
    except Exception as e:
        print(f"WARN gemini triage parse: {e}", file=sys.stderr)
        return []


def local_fallback_triage(analysis):
    """
    Rule-based fallback when Gemini didn't return a result for a record.
    Returns a triage dict with the same shape as Gemini output.
    """
    if not analysis.get("has_code_html") or not analysis.get("preview_has_content"):
        return {"id": analysis["id"], "classification": "WAITING", "issues": [], "review_notes": ""}

    issues = []
    if analysis.get("dark_mode_count", 0) < 3:
        issues.append("missing or insufficient dark: Tailwind variants")
    if analysis.get("responsive_count", 0) < 2:
        issues.append("missing responsive breakpoints (sm: md: lg:)")
    if analysis.get("has_hardcoded_colors"):
        issues.append("hardcoded color values — replace with Tailwind classes")
    if analysis.get("desc_word_count", 0) < 15 or analysis.get("desc_mentions_source"):
        issues.append("description needs rewrite — too short or mentions source library")

    if issues:
        return {"id": analysis["id"], "classification": "FIXABLE", "issues": issues, "review_notes": ""}
    return {"id": analysis["id"], "classification": "PASS", "issues": [], "review_notes": ""}


# ---------- Anthropic Batch API ----------

_CLAUDE_SYSTEM = """\
You are a UI component code fixer. Fix ONLY the specific issues listed.
Return valid JSON with the corrected fields. Do NOT change component structure,
props, event handlers, or behaviour.

Dark mode fixes: add dark: variants to every colour class.
  Examples: bg-white → bg-white dark:bg-zinc-900
            text-black → text-black dark:text-white
            border-gray-200 → border-gray-200 dark:border-zinc-700

Responsive fixes: add Tailwind breakpoints.
  Example: grid-cols-3 → grid-cols-1 sm:grid-cols-2 lg:grid-cols-3

Hardcoded colour fixes: replace bg-[#fff] / inline style colours with
  semantic Tailwind classes (with dark: variants).

Description fixes: rewrite as exactly 2–3 crisp sentences.
  What the component does + a realistic use case for a buyer.
  Do NOT mention the source library (no "Magic UI", "21st.dev", etc.).

Do NOT include <html> or <body> wrappers in Code HTML — just the
component fragment. Do NOT edit Prompt Text.

Return JSON (no markdown fences):
{"code_html":"...","code_react":"...","description":"..."}
Set a field to null if that field needs no change."""


def build_batch_request(record, issues):
    """Build one Anthropic batch request item for a FIXABLE record."""
    f = record.get("fields", {})
    user_msg = (
        f"Component: {f.get(F_NAME, 'Unknown')}\n"
        f"Issues to fix:\n" +
        "\n".join(f"  - {issue}" for issue in issues) +
        f"\n\nDescription:\n{f.get(F_DESCRIPTION) or '(empty)'}\n\n"
        f"Code HTML:\n{f.get(F_CODE_HTML) or '(empty)'}\n\n"
        f"Code React:\n{f.get(F_CODE_REACT) or '(empty)'}"
    )
    return {
        "custom_id": record["id"],
        "params": {
            "model":      CLAUDE_MODEL,
            "max_tokens": 8192,
            "system":     _CLAUDE_SYSTEM,
            "messages":   [{"role": "user", "content": user_msg}],
        },
    }


def submit_batch(requests, anthropic_key):
    """Submit a message batch. Returns batch_id string or None on failure."""
    headers = {
        "x-api-key":          anthropic_key,
        "anthropic-version":  ANTHROPIC_VERSION,
        "anthropic-beta":     "message-batches-2024-09-24",
    }
    status, body = http(ANTHROPIC_BATCH_URL, method="POST", headers=headers,
                        body={"requests": requests})
    if status != 200:
        print(f"WARN batch submit: HTTP {status} {body[:300]!r}", file=sys.stderr)
        return None
    data     = json.loads(body)
    batch_id = data["id"]
    print(f"batch submitted: {batch_id} ({len(requests)} requests)")
    return batch_id


def poll_batch(batch_id, anthropic_key, timeout=BATCH_TIMEOUT):
    """Poll until processing_status == 'ended'. Returns True on success."""
    headers = {
        "x-api-key":         anthropic_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta":    "message-batches-2024-09-24",
    }
    url      = f"{ANTHROPIC_BATCH_URL}/{batch_id}"
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, body = http(url, headers=headers)
        if status != 200:
            print(f"WARN batch poll: HTTP {status}", file=sys.stderr)
            time.sleep(BATCH_POLL_INTERVAL)
            continue
        data              = json.loads(body)
        processing_status = data.get("processing_status", "")
        counts            = data.get("request_counts", {})
        print(f"batch {batch_id}: {processing_status} — {counts}")
        if processing_status == "ended":
            return True
        time.sleep(BATCH_POLL_INTERVAL)
    print(f"WARN batch {batch_id}: timed out after {timeout}s", file=sys.stderr)
    return False


def fetch_batch_results(batch_id, anthropic_key):
    """
    Fetch JSONL results for a completed batch.
    Returns dict {custom_id: result_text_or_None}.
    """
    headers = {
        "x-api-key":         anthropic_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta":    "message-batches-2024-09-24",
    }
    url    = f"{ANTHROPIC_BATCH_URL}/{batch_id}/results"
    status, body = http(url, headers=headers)
    if status != 200:
        print(f"WARN batch results: HTTP {status} {body[:200]!r}", file=sys.stderr)
        return {}
    results = {}
    for line in body.decode("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item      = json.loads(line)
            custom_id = item["custom_id"]
            result    = item["result"]
            if result["type"] == "succeeded":
                results[custom_id] = result["message"]["content"][0]["text"]
            else:
                print(f"WARN batch result {custom_id}: {result.get('type')} "
                      f"— {result.get('error', {})}", file=sys.stderr)
                results[custom_id] = None
        except Exception as e:
            print(f"WARN batch result parse: {e}", file=sys.stderr)
    return results


def parse_fix_response(text):
    """Parse Claude's JSON fix response. Returns dict or None on failure."""
    if not text:
        return None
    try:
        content = text.strip()
        if content.startswith("```"):
            parts   = content.split("```")
            content = parts[1] if len(parts) > 1 else content
            if content.lower().startswith("json\n"):
                content = content[5:]
            content = content.strip()
        return json.loads(content)
    except Exception as e:
        print(f"WARN fix parse: {e}", file=sys.stderr)
        return None


# ---------- Slack ----------

def post_slack(text, webhook_url):
    status, _ = http(webhook_url, method="POST", body={"text": text})
    if status not in (200, 204):
        print(f"WARN slack: HTTP {status}", file=sys.stderr)


# ---------- Main ----------

def main():
    at_key        = os.environ["AIRTABLE_API_KEY"]
    anthropic_key = os.environ["ANTHROPIC_API_KEY"]
    slack_webhook = os.environ["TRIAGE_SLACK_WEBHOOK"]
    today         = datetime.now(timezone.utc).date().isoformat()

    print(f"pk-review run: {today}")

    gemini_key = get_gemini_key(at_key)
    if gemini_key:
        print(f"gemini key: loaded (suffix=...{gemini_key[-4:]})")
    else:
        print("WARN: no Gemini key — triage will use local fallback rules", file=sys.stderr)

    # ── Step 1: Fetch Draft records ──────────────────────────────────────────
    print(f"fetching up to {BATCH_SIZE} Draft records...")
    records = at_list_records(
        PK_BASE, PK_TABLE, at_key,
        filter_formula="{Published}='Draft'",
        fields=[F_NAME, F_DESCRIPTION, F_CODE_HTML, F_CODE_REACT,
                F_TAGS, F_CATEGORY, F_STYLE, F_PUBLISHED],
        max_records=BATCH_SIZE,
    )
    print(f"fetched {len(records)} Draft records")

    if not records:
        msg = "pk-review: no Draft records — nothing to do"
        print(msg)
        post_slack(msg, slack_webhook)
        return

    # ── Step 2: Fetch preview URLs ───────────────────────────────────────────
    print("checking preview URLs...")
    preview_map = {}  # {record_id: (status, has_content)}
    for r in records:
        p_status, p_content = fetch_preview(r["id"])
        preview_map[r["id"]] = (p_status, p_content)
        time.sleep(0.1)

    # ── Step 3: Local structural analysis ────────────────────────────────────
    analyses = []
    for r in records:
        p_status, p_content = preview_map[r["id"]]
        analyses.append(analyze_record(r, p_status, p_content))

    # ── Step 4: Gemini triage ─────────────────────────────────────────────────
    triage_map = {}
    if gemini_key:
        print(f"Gemini triage: {len(analyses)} records...")
        raw_triage = gemini_triage(analyses, gemini_key)
        for t in raw_triage:
            triage_map[t["id"]] = t
        print(f"Gemini triage: {len(triage_map)} results")

    # Fill any gaps with local fallback rules
    analysis_by_id = {a["id"]: a for a in analyses}
    for r in records:
        if r["id"] not in triage_map:
            triage_map[r["id"]] = local_fallback_triage(analysis_by_id[r["id"]])

    # Bucket by classification
    by_class = {"PASS": [], "FIXABLE": [], "UNFIXABLE": [], "WAITING": []}
    for r in records:
        cls = triage_map[r["id"]].get("classification", "WAITING")
        by_class.setdefault(cls, []).append(r)

    print(f"triage results: PASS={len(by_class['PASS'])}  "
          f"FIXABLE={len(by_class['FIXABLE'])}  "
          f"UNFIXABLE={len(by_class['UNFIXABLE'])}  "
          f"WAITING={len(by_class['WAITING'])}")

    # ── Step 5: Apply immediate verdicts ─────────────────────────────────────
    immediate = []
    for r in by_class["PASS"]:
        immediate.append({"id": r["id"], "fields": {F_PUBLISHED: "Ready for Review"}})
    for r in by_class["UNFIXABLE"]:
        note = triage_map[r["id"]].get("review_notes") or "Unfixable — manual review required"
        immediate.append({"id": r["id"], "fields": {
            F_PUBLISHED:    "Needs Work",
            F_REVIEW_NOTES: note,
        }})
    # WAITING → leave as Draft, no update

    if immediate:
        done = at_update_records(PK_BASE, PK_TABLE, immediate, at_key)
        print(f"immediate verdicts applied: {done} records updated")

    # ── Step 6–9: Batch fix FIXABLE records ──────────────────────────────────
    auto_fixed   = []   # records successfully fixed + verified
    fix_failed   = []   # records where fix failed or verify failed

    if by_class["FIXABLE"]:
        print(f"building Anthropic batch for {len(by_class['FIXABLE'])} FIXABLE records...")
        batch_requests = [
            build_batch_request(r, triage_map[r["id"]].get("issues", []))
            for r in by_class["FIXABLE"]
        ]

        batch_id = submit_batch(batch_requests, anthropic_key)

        if batch_id:
            success = poll_batch(batch_id, anthropic_key)

            if success:
                raw_results = fetch_batch_results(batch_id, anthropic_key)
                fix_updates = []

                for r in by_class["FIXABLE"]:
                    rid  = r["id"]
                    fix  = parse_fix_response(raw_results.get(rid))

                    if not fix:
                        fix_failed.append(r)
                        fix_updates.append({"id": rid, "fields": {
                            F_PUBLISHED:    "Needs Work",
                            F_REVIEW_NOTES: "Auto-fix failed: Claude response could not be parsed",
                        }})
                        continue

                    fields = {}
                    if fix.get("code_html"):
                        fields[F_CODE_HTML] = fix["code_html"]
                    if fix.get("code_react"):
                        fields[F_CODE_REACT] = fix["code_react"]
                    if fix.get("description"):
                        fields[F_DESCRIPTION] = fix["description"]
                    fields[F_PUBLISHED] = "Ready for Review"
                    fix_updates.append({"id": rid, "fields": fields})
                    auto_fixed.append(r)

                if fix_updates:
                    done = at_update_records(PK_BASE, PK_TABLE, fix_updates, at_key)
                    print(f"fix updates applied: {done} records")

                # ── Step 9: Re-verify previews for auto-fixed records ─────────
                downgraded = []
                for r in list(auto_fixed):
                    time.sleep(0.5)  # let Airtable/Worker catch up
                    v_status, v_content = fetch_preview(r["id"])
                    if v_status != 200 or not v_content:
                        print(f"WARN preview verify failed {r['id']}: HTTP {v_status}",
                              file=sys.stderr)
                        auto_fixed.remove(r)
                        downgraded.append(r)

                if downgraded:
                    at_update_records(PK_BASE, PK_TABLE, [
                        {"id": r["id"], "fields": {
                            F_PUBLISHED:    "Needs Work",
                            F_REVIEW_NOTES: "Auto-fix applied but preview failed to render after update",
                        }}
                        for r in downgraded
                    ], at_key)
                    fix_failed.extend(downgraded)
                    print(f"verify: {len(downgraded)} records downgraded to Needs Work")

            else:
                # Batch timed out
                timeout_updates = [
                    {"id": r["id"], "fields": {
                        F_PUBLISHED:    "Needs Work",
                        F_REVIEW_NOTES: "Auto-fix batch timed out — will retry on next run",
                    }}
                    for r in by_class["FIXABLE"]
                ]
                at_update_records(PK_BASE, PK_TABLE, timeout_updates, at_key)
                fix_failed = list(by_class["FIXABLE"])
        else:
            # Batch submission failed
            fix_failed = list(by_class["FIXABLE"])

    # ── Step 10: Slack summary ────────────────────────────────────────────────
    n_total    = len(records)
    n_pass     = len(by_class["PASS"])
    n_fixed    = len(auto_fixed)
    n_waiting  = len(by_class["WAITING"])
    n_unfixable = len(by_class["UNFIXABLE"])
    needs_work  = by_class["UNFIXABLE"] + fix_failed

    lines = [f"*pk-review complete — {n_total} reviewed*"]
    if n_pass:
        lines.append(f"✓ {n_pass} passed → Ready for Review")
    if n_fixed:
        lines.append(f"✓ {n_fixed} auto-fixed → Ready for Review")
    if n_waiting:
        lines.append(f"⏳ {n_waiting} waiting for pipeline (Code HTML not generated yet — still Draft)")
    if needs_work:
        lines.append(f"! {len(needs_work)} need human eyes:")
        for r in needs_work:
            t    = triage_map.get(r["id"], {})
            note = (t.get("review_notes") or "see review notes")[:100]
            name = (r.get("fields", {}).get(F_NAME) or r["id"])
            lines.append(f"  • {name} — {note}")

    summary = "\n".join(lines)
    print(summary)
    post_slack(summary, slack_webhook)


if __name__ == "__main__":
    main()
