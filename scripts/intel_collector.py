#!/usr/bin/env python3
"""
Intel collector — runs daily via GitHub Actions.

Pulls from Monitored Platforms (Airtable-configured), Hacker News, ProductHunt,
GitHub topic search, and public-apis. Upserts new items into Airtable tables
(Platform Updates, AI News, Deals, Skills, APIs) with Decision=Pending.

The Mon/Thu strategic-intel-brief Claude routine reviews the Pending items,
filters by HypeBase relevance, and sets real Decision values.

Stdlib only. No third-party deps.

Env vars required:
  TRIAGE_GH_TOKEN    PAT with public_repo or repo (read) scope
  AIRTABLE_API_KEY   PAT with data.records:read/write on base app6biS7yjV6XzFVG
"""
import email.utils as eu
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib import request, error
from urllib.parse import quote

# ---------- Airtable layout ----------

AIRTABLE_BASE = "app6biS7yjV6XzFVG"

TABLE_MONITORED = "tbldabNFfzcs35YXn"
TABLE_PLATFORM  = "tblW6XV9X5gBrghOv"
TABLE_NEWS      = "tbl4IUWP09vzchU5t"
TABLE_DEALS     = "tbl9a3WVIhW7NddYz"
TABLE_SKILLS    = "tblRYHxXNItKHXqg7"
TABLE_APIS      = "tblhsuuFCDKmO1Ho3"

# Monitored Platforms
F_M_NAME         = "fldweyAemSTkEb3ej"  # primary
F_M_TIER         = "fldRNBPsWXEwqkeuw"
F_M_METHOD       = "fldF6kdxfXCFNaR40"
F_M_SOURCE_URL   = "fldtZLPqZX9BVk2dn"
F_M_CATEGORY     = "fldMwWlXmDYfoiNhR"
F_M_ACTIVE       = "fldiYywh64gn9BBl0"
F_M_LAST_CHECKED = "fld048If9pGGu3aX3"
F_M_LAST_FINDING = "fldsQ8hr2qcN2b3h3"

# Platform Updates
F_P_TITLE      = "fld6MygJickboWiDR"  # primary
F_P_PLATFORM   = "fldIMyCODCknn16Qn"
F_P_TIER       = "fldg2zP6VtGFSPHFc"
F_P_DATE_SHIP  = "fldSImOhCRKwn79tH"
F_P_DATE_FOUND = "fldZokhfXYpFyle7r"
F_P_SUMMARY    = "fldci74YwZMfoVwwu"
F_P_SOURCE_URL = "fldPURpzGk3tYrBlN"
F_P_DECISION   = "fldqLWYmmj177vxBK"

# AI News
F_N_HEADLINE   = "fldLZrIAoWNarkPpz"  # primary
F_N_SOURCE     = "fldxsXh8jszGhyc8B"
F_N_SOURCE_URL = "fld1gKpZXdN0B9fDh"
F_N_DATE_PUB   = "fldOKG0xktU1hdQNw"
F_N_DATE_FOUND = "fldF3HdWp5MXCCkSS"
F_N_SUMMARY    = "fldmJnLuYInRYu7EK"
F_N_DECISION   = "fld1HI3TMTG6oV0Gd"

# Deals
F_D_NAME       = "fldd6P0A3QmYImHdn"  # primary
F_D_SOURCE     = "fldQafNnNbBBASxQt"
F_D_SOURCE_URL = "fldKsLUT8LOsaiv8e"
F_D_DATE_FOUND = "fldbsVxRfrJfErKGI"
F_D_DESC       = "fldLNvj3T8yAAxUQY"
F_D_DECISION   = "fld2d5QZA0bDL0GLA"

# Skills
F_S_NAME       = "fldWkR24Xvv9QwlhC"  # primary
F_S_TYPE       = "fldkprz8WpS1ISkbC"
F_S_SOURCE     = "fldCFeoaxufuj6DdX"
F_S_SOURCE_URL = "fldsPZ14Bt4wuWxhH"
F_S_DESC       = "fld9gzPlHxkvTaYti"
F_S_DATE_FOUND = "fld1leHJYMR7A3CAD"

# APIs
F_A_NAME           = "fldnqYSphdSsFkZMK"  # primary
F_A_PROVIDER       = "fldSuUFCk3RK4P7Nc"
F_A_MARKETPLACE    = "fldPaQSygpMD5teaS"
F_A_MARKETPLACE_URL= "fldm3IQkEnDh5QU4s"
F_A_DATE_FOUND     = "fldK2elEC2BgiLIMt"
F_A_CATEGORY       = "fld3DQfFMnh2Pnel3"
F_A_DESCRIPTION    = "fldwKCO6Wf2fx63Og"
F_A_FREE_TIER      = "fldiovdOzNOT9JIG5"
F_A_STATUS         = "fldaz4qu3qbpN7kNI"
F_A_DECISION       = "fldrcHE03dHImIR2A"

# Notes fields (used for pre-classifier reason strings)
F_N_NOTES       = "fldIyGfUfsKmjFSnq"  # AI News
F_D_NOTES       = "fldxRN1xdAfcSFx8c"  # Deals
F_S_AUDIT_NOTES = "fldswaN5jLkCzogde"  # Skills

# Logins & Keys
TABLE_LOGINS_KEYS = "tbldJkG11gY1W3jTf"
F_LK_NAME         = "fldQqf8eF4mT2U0zT"  # primary
F_LK_KEYS         = "fld4fYgMypJz9Iete"
F_LK_STATUS       = "fldcZ9nAY8GD2OZW8"

# OpenRouter pre-classifier config
OPENROUTER_MODEL = "deepseek/deepseek-chat"
OPENROUTER_URL   = "https://openrouter.ai/api/v1/chat/completions"
PRE_CLASSIFY_BATCH_SIZE = 15

HYPEBASE_CONTEXT_FOR_CLASSIFIER = (
    "HypeBase is a talent/entertainment data platform. Python + TypeScript scrapers "
    "on GitHub Actions write enriched profiles to Supabase. 17+ scrapers cover music "
    "(Spotify, Deezer, MusicBrainz, TheAudioDB, AllMusic, SoundCloud), film/TV "
    "(IMDb, IMDbPro, TMDb), sports (RealGM, Transfermarkt), social (Twitter, "
    "Instagram, Bandsintown), events (Songkick, Last.fm). Webapps use Next.js + "
    "Supabase. Ops in Airtable. Claude Code for dev + scheduled routines. Looking "
    "for: scraping tools, data enrichment APIs, agent/AI skills, dev tooling, cost "
    "savings on AI/APIs, Claude Code updates, Airtable/Supabase/Slack enhancements. "
    "NOT relevant: consumer apps, gaming, weather, health, crypto, photography, "
    "education, currency, generic text tools."
)

# ---------- Source config ----------

AI_KEYWORDS = [
    "ai", "claude", "gpt", "llm", "openai", "anthropic", "gemini", "perplexity",
    "mistral", "deepseek", "grok", "qwen", "agent", "rag", "embedding",
    "chatgpt", "copilot", "cursor", "transformer", "huggingface",
    "prompt engineer", "fine-tun", "scraping", "automation", "workflow",
]

DEAL_KEYWORDS = [
    "ai", "developer", "api", "automation", "productivity", "data", "scraping",
    "analytics", "workflow", "database", "dashboard", "monitoring", "saas",
    "agent", "llm", "enrichment",
]

SKILL_TOPICS = [
    "claude-code-skills",
    "claude-skills",
    "anthropic-skills",
    "claude-plugins",
    "claude-subagent",
    "claude-agent",
    "claude-code",
    "mcp-server",
    "anthropic-mcp",
    "agent-skills",
]

# Specific repos we always want in the Skills table (not discovered via topic search).
WATCHED_SKILL_REPOS = [
    "anthropics/skills",           # official Anthropic aggregator
    "obra/superpowers",            # custom agent skills
    "posit-dev/skills",            # Posit / data science skills
    "yamadashy/repomix",           # repo-packing utility for LLMs
]

# Awesome-lists to parse for GitHub repo references. The README of each is
# fetched; every [name](https://github.com/owner/repo) link becomes a skill entry.
AWESOME_SKILL_LISTS = [
    "ComposioHQ/awesome-claude-skills",
    "VoltAgent/awesome-agent-skills",
    "travisvn/awesome-claude-skills",
]

# Hugging Face trending models — pulls top N by recent trending score.
HF_TOP_LIMIT = 30
HF_MIN_DOWNLOADS = 1000

# public-apis.org categories relevant to HypeBase (talent/entertainment data)
API_CATEGORIES_RELEVANT = {
    "Music",
    "Video",
    "Movies",
    "Entertainment",
    "Sports & Fitness",
    "Sports",
    "Social",
    "News",
    "Calendar",
    "Games & Comics",
    "Games",
    "Business",
    "Data Validation",
    "Open Data",
    "Jobs",  # for artist booking adjacent signals
}

LOOKBACK_DAYS  = 3
SKILL_LOOKBACK = 21
HN_TOP_LIMIT   = 200
SUMMARY_CAP    = 1800
SLEEP          = 0.3

DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 intel-collector"
)

# ---------- HTTP ----------

def http(url, method="GET", headers=None, body=None, timeout=30):
    headers = dict(headers or {})
    headers.setdefault("User-Agent", DEFAULT_UA)
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    req = request.Request(url, method=method, headers=headers, data=body)
    try:
        with request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except error.HTTPError as e:
        return e.code, e.read()
    except error.URLError as e:
        return 599, str(e).encode()


# ---------- Feed parsers ----------

def parse_feed(xml_bytes):
    """RSS 2.0 + Atom. Returns list of {title, link, summary, date}."""
    out = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        print(f"WARN feed parse: {e}", file=sys.stderr)
        return out
    for entry in root.iter():
        tag = entry.tag.lower().rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        title = link = summary = date = None
        for child in entry:
            ctag = child.tag.lower().rsplit("}", 1)[-1]
            if ctag == "title" and title is None:
                title = (child.text or "").strip()
            elif ctag == "link" and link is None:
                link = (child.text or "").strip() or child.attrib.get("href", "")
            elif ctag in ("description", "summary", "content") and summary is None:
                summary = (child.text or "").strip()
            elif ctag in ("pubdate", "published", "updated", "date") and date is None:
                date = (child.text or "").strip()
        if title and link:
            out.append({"title": title, "link": link,
                        "summary": (summary or "")[:SUMMARY_CAP],
                        "date": date or ""})
    return out


def parse_date(s):
    """YYYY-MM-DD or None. Handles ISO 8601 and RFC 822."""
    if not s:
        return None
    s = s.strip()
    try:
        if len(s) >= 10 and s[:4].isdigit() and s[4] == "-":
            return s[:10]
        dt = eu.parsedate_to_datetime(s)
        return dt.strftime("%Y-%m-%d") if dt else None
    except Exception:
        return None


def extract_gh_repo(url):
    """https://github.com/foo/bar[/tree/main] → foo/bar"""
    if not url:
        return None
    m = re.match(r"https?://github\.com/([\w.-]+)/([\w.-]+)", url)
    if not m:
        return None
    return f"{m.group(1)}/{m.group(2)}"


# ---------- Source fetchers ----------

def gh_releases(repo, token, days=LOOKBACK_DAYS):
    url = f"https://api.github.com/repos/{repo}/releases?per_page=10"
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json"}
    status, body = http(url, headers=headers)
    if status >= 400:
        print(f"WARN gh_releases {repo}: {status} {body[:200]!r}", file=sys.stderr)
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for r in json.loads(body):
        pub = r.get("published_at")
        if not pub:
            continue
        try:
            pub_dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
        except ValueError:
            continue
        if pub_dt < cutoff:
            continue
        out.append({
            "title": r.get("name") or r.get("tag_name") or "(unnamed)",
            "link":  r.get("html_url", ""),
            "summary": (r.get("body") or "")[:SUMMARY_CAP],
            "date":  pub,
        })
    return out


def gh_topic_search(topic, token, days=SKILL_LOOKBACK):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    q = f"topic:{topic} pushed:>={since}"
    url = f"https://api.github.com/search/repositories?q={quote(q)}&sort=updated&per_page=20"
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json"}
    status, body = http(url, headers=headers)
    if status >= 400:
        print(f"WARN gh_topic {topic}: {status} {body[:200]!r}", file=sys.stderr)
        return []
    out = []
    for item in json.loads(body).get("items", []):
        out.append({
            "title": item.get("full_name", ""),
            "link":  item.get("html_url", ""),
            "summary": (item.get("description") or "")[:1000],
            "date":  item.get("updated_at", ""),
        })
    return out


def hn_top(keywords, days=LOOKBACK_DAYS, limit=HN_TOP_LIMIT):
    status, body = http("https://hacker-news.firebaseio.com/v0/topstories.json")
    if status >= 400:
        return []
    ids = json.loads(body)[:limit]
    cutoff_ts = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp()
    kw_lc = [k.lower() for k in keywords]
    out = []
    for sid in ids:
        s, b = http(f"https://hacker-news.firebaseio.com/v0/item/{sid}.json")
        if s >= 400:
            continue
        try:
            item = json.loads(b)
        except Exception:
            continue
        if not item or item.get("time", 0) < cutoff_ts:
            continue
        title = item.get("title", "")
        if not any(k in title.lower() for k in kw_lc):
            continue
        out.append({
            "title": title,
            "link":  item.get("url") or f"https://news.ycombinator.com/item?id={sid}",
            "summary": (item.get("text", "") or "")[:1000],
            "date":  datetime.fromtimestamp(item["time"], tz=timezone.utc).isoformat(),
        })
    return out


def public_apis_readme():
    """Fetch + parse public-apis README into category-tagged entries."""
    url = "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md"
    status, body = http(url)
    if status >= 400:
        print(f"WARN public-apis README: {status}", file=sys.stderr)
        return []
    content = body.decode("utf-8", errors="replace")

    entries = []
    current_category = None
    # Regex for a table data row like: | [Name](url) | Description | Auth | HTTPS | CORS |
    row_re = re.compile(r"^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|")

    for line in content.splitlines():
        line_stripped = line.strip()
        # Section header: "### Music"
        if line_stripped.startswith("### "):
            current_category = line_stripped[4:].strip()
            continue
        if not current_category:
            continue
        # Skip table header and separator rows
        if line_stripped.startswith("| API ") or line_stripped.startswith("|---"):
            continue
        m = row_re.match(line_stripped)
        if m:
            name, link, desc, auth, https = (
                m.group(1).strip(), m.group(2).strip(),
                m.group(3).strip(), m.group(4).strip(), m.group(5).strip(),
            )
            entries.append({
                "name": name, "url": link, "description": desc,
                "auth": auth, "https": https, "category": current_category,
            })
    return entries


def publicapis_dev():
    """Stub: publicapis.dev is a static site, no public API endpoint.
    Kept for API compatibility with collect_apis(); always returns []."""
    return []


def gh_readme(repo, token):
    """Fetch raw README content for a GitHub repo. Returns empty string on failure."""
    url = f"https://api.github.com/repos/{repo}/readme"
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github.raw"}
    status, body = http(url, headers=headers)
    if status >= 400:
        print(f"WARN gh_readme {repo}: {status}", file=sys.stderr)
        return ""
    return body.decode("utf-8", errors="replace")


def gh_repo_info(repo, token):
    """Get basic info for a repo: title (owner/repo), link, summary, date."""
    url = f"https://api.github.com/repos/{repo}"
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json"}
    status, body = http(url, headers=headers)
    if status >= 400:
        print(f"WARN gh_repo_info {repo}: {status} {body[:200]!r}", file=sys.stderr)
        return None
    d = json.loads(body)
    return {
        "title": d.get("full_name", repo),
        "link":  d.get("html_url", f"https://github.com/{repo}"),
        "summary": (d.get("description") or "")[:1000],
        "date":  d.get("updated_at", ""),
    }


# Matches: [Name](https://github.com/owner/repo[...]) optional " - desc"
_AWESOME_RE = re.compile(
    r"\[([^\]]{1,200})\]\(https?://github\.com/([\w.-]+)/([\w.-]+?)(?:[#?/][^)]*)?\)"
    r"(?:\s*[-—:·]\s*(.+?))?(?:$|\n)",
    re.IGNORECASE,
)

# Repo-name segments we should NOT treat as a real repo (these are common URL paths)
_SKIP_REPO_NAMES = {"archive", "blob", "tree", "wiki", "issues", "pulls",
                    "releases", "actions", "pulse", "network", "graphs",
                    "stargazers", "watchers", "fork", "compare", "commit",
                    "commits", "settings"}


def parse_awesome_list(content):
    """Extract (full_name, url, description) tuples from markdown pointing to GH repos."""
    out = []
    seen = set()
    for m in _AWESOME_RE.finditer(content):
        owner = m.group(2).strip()
        repo = m.group(3).strip().rstrip(".")
        desc = (m.group(4) or "").strip()
        if not repo or repo.lower() in _SKIP_REPO_NAMES:
            continue
        full = f"{owner}/{repo}"
        if full in seen:
            continue
        seen.add(full)
        out.append({
            "title": full,
            "link":  f"https://github.com/{full}",
            "summary": desc[:500],
            "date":  "",
        })
    return out


def hf_trending_models():
    """Pull top trending Hugging Face models. Returns a list of item dicts."""
    # HF's sort key is `trendingScore`, not `trending`.
    url = f"https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit={HF_TOP_LIMIT}"
    status, body = http(url)
    if status >= 400:
        print(f"WARN hf trending: {status}", file=sys.stderr)
        return []
    try:
        models = json.loads(body)
    except Exception:
        return []
    out = []
    for m in models:
        downloads = m.get("downloads", 0) or 0
        if downloads < HF_MIN_DOWNLOADS:
            continue
        mid = m.get("id") or m.get("modelId", "")
        if not mid:
            continue
        out.append({
            "title": f"HF model: {mid}",
            "link":  f"https://huggingface.co/{mid}",
            "summary": f"Downloads: {downloads:,} | Likes: {m.get('likes', 0)} | Task: {m.get('pipeline_tag') or 'unknown'}",
            "date":  m.get("lastModified", ""),
        })
    return out


# ---------- Airtable ----------

def at_list_all(base, table, field_ids, key_token):
    headers = {"Authorization": f"Bearer {key_token}"}
    all_rows = []
    offset = None
    while True:
        qs = "pageSize=100&returnFieldsByFieldId=true"
        if offset:
            qs += f"&offset={offset}"
        if field_ids:
            qs += "&" + "&".join(f"fields[]={f}" for f in field_ids)
        status, body = http(f"https://api.airtable.com/v0/{base}/{table}?{qs}", headers=headers)
        if status >= 400:
            print(f"WARN airtable list {table}: {status} {body[:300]!r}", file=sys.stderr)
            break
        data = json.loads(body)
        all_rows.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
        time.sleep(SLEEP)
    return all_rows


def at_existing_titles(base, table, primary_field_id, key_token):
    rows = at_list_all(base, table, [primary_field_id], key_token)
    out = set()
    for r in rows:
        v = (r.get("fields", {}) or {}).get(primary_field_id)
        if isinstance(v, str):
            out.add(v.strip().lower())
    return out


def at_create(base, table, records, key_token):
    if not records:
        return 0
    headers = {"Authorization": f"Bearer {key_token}",
               "Content-Type": "application/json"}
    url = f"https://api.airtable.com/v0/{base}/{table}"
    created = 0
    for i in range(0, len(records), 10):
        payload = {"records": [{"fields": r} for r in records[i:i + 10]],
                   "typecast": True}
        status, body = http(url, method="POST", headers=headers, body=payload)
        if status >= 400:
            print(f"WARN airtable create {table}: {status} {body[:500]!r}", file=sys.stderr)
            continue
        created += len(json.loads(body).get("records", []))
        time.sleep(SLEEP)
    return created


def get_openrouter_key_from_airtable(at_key):
    """Fetch the OpenRouter key from the Airtable Logins & Keys table.

    Searches for a row whose Name matches 'Open Router' / 'OpenRouter' / 'openrouter'
    and extracts the first line starting with 'sk-or-' from its Keys field.
    Falls back to the OPENROUTER_API_KEY env var if Airtable lookup fails.
    Returns None if neither source has a usable key. Never logs the value.
    """
    try:
        rows = at_list_all(
            AIRTABLE_BASE, TABLE_LOGINS_KEYS, [F_LK_NAME, F_LK_KEYS], at_key
        )
    except Exception as e:
        print(f"WARN openrouter key airtable lookup: {e}", file=sys.stderr)
        rows = []
    for r in rows:
        f = r.get("fields", {}) or {}
        name = (f.get(F_LK_NAME) or "").strip().lower().replace(" ", "")
        if name not in ("openrouter", "open-router", "openrouterapikey"):
            continue
        keys_text = f.get(F_LK_KEYS) or ""
        for line in keys_text.splitlines():
            line = line.strip()
            if line.startswith("sk-or-"):
                print(f"openrouter: key loaded from Airtable row (len={len(line)}, "
                      f"suffix=...{line[-4:]})")
                return line
    env_val = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
    if env_val:
        print(f"openrouter: key loaded from OPENROUTER_API_KEY env (len={len(env_val)}, "
              f"suffix=...{env_val[-4:]})")
        return env_val
    print("WARN openrouter: no key found in Airtable or env — pre-classifier disabled",
          file=sys.stderr)
    return None


def pre_classify(items, openrouter_key):
    """Batch-classify items via OpenRouter. Returns list of dicts in input order:
    [{'decision': 'relevant'|'irrelevant'|'maybe', 'reason': str}, ...].

    Safe to call with None key or empty list. On any failure, returns 'maybe' for
    every item so nothing gets auto-dismissed on classifier errors.
    """
    if not items or not openrouter_key:
        return [{"decision": "maybe", "reason": "classifier disabled"} for _ in items]

    results = [None] * len(items)
    for start in range(0, len(items), PRE_CLASSIFY_BATCH_SIZE):
        batch = items[start : start + PRE_CLASSIFY_BATCH_SIZE]
        batch_in = [
            {"id": i, "title": (it.get("title") or "")[:200],
             "desc": (it.get("summary") or "")[:300]}
            for i, it in enumerate(batch)
        ]
        prompt = (
            f"You are filtering items for a strategic intelligence brief.\n\n"
            f"CONTEXT: {HYPEBASE_CONTEXT_FOR_CLASSIFIER}\n\n"
            f"For each item below, output one of: 'relevant', 'irrelevant', or 'maybe'. "
            f"Be strict — mark as 'relevant' only if it clearly helps HypeBase. Mark "
            f"'irrelevant' only if you're confident it doesn't help. Use 'maybe' when "
            f"unsure — a human will re-check.\n\n"
            f"INPUT (JSON): {json.dumps(batch_in)}\n\n"
            f"OUTPUT: JSON array of the same length, in the same order, each element "
            f"shaped like: {{\"decision\": \"relevant\"|\"irrelevant\"|\"maybe\", "
            f"\"reason\": \"<=12 words\"}}\n"
            f"No preamble, no markdown fences, just the JSON array."
        )
        headers = {
            "Authorization": f"Bearer {openrouter_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/bwbcollier-byte/rco_admin",
            "X-Title": "HypeBase Intel Collector",
        }
        body = json.dumps({
            "model": OPENROUTER_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 1500,
            "temperature": 0,
        }).encode()
        status, resp_body = http(OPENROUTER_URL, method="POST", headers=headers, body=body)
        if status >= 400:
            print(f"WARN pre_classify batch {start}: {status} {resp_body[:200]!r}",
                  file=sys.stderr)
            for i in range(len(batch)):
                results[start + i] = {"decision": "maybe", "reason": "classifier HTTP error"}
            continue
        try:
            resp = json.loads(resp_body)
            content = (resp.get("choices", [{}])[0].get("message", {}).get("content") or "").strip()
            # Strip markdown fences if model ignored the instruction
            if content.startswith("```"):
                fences = content.split("```")
                if len(fences) >= 2:
                    content = fences[1]
                    if content.lower().startswith("json\n") or content.lower().startswith("json "):
                        content = content[4:].lstrip()
                    if content.endswith("\n"):
                        content = content.rstrip()
            parsed = json.loads(content)
            if isinstance(parsed, list) and len(parsed) == len(batch):
                for i, dec in enumerate(parsed):
                    if not isinstance(dec, dict):
                        dec = {"decision": "maybe", "reason": "malformed response item"}
                    d = (dec.get("decision") or "").strip().lower()
                    if d not in ("relevant", "irrelevant", "maybe"):
                        d = "maybe"
                    results[start + i] = {
                        "decision": d,
                        "reason": (dec.get("reason") or "")[:200],
                    }
            else:
                raise ValueError(f"length mismatch: got {len(parsed) if isinstance(parsed, list) else 'non-list'}, want {len(batch)}")
        except Exception as e:
            print(f"WARN pre_classify batch {start} parse: {e}", file=sys.stderr)
            for i in range(len(batch)):
                results[start + i] = {"decision": "maybe", "reason": "classifier parse error"}
        time.sleep(SLEEP)

    counts = {"relevant": 0, "irrelevant": 0, "maybe": 0}
    for r in results:
        counts[r["decision"]] = counts.get(r["decision"], 0) + 1
    print(f"pre_classify: relevant={counts['relevant']} "
          f"irrelevant={counts['irrelevant']} maybe={counts['maybe']} "
          f"(model={OPENROUTER_MODEL}, {len(items)} items)")
    return results


def apply_pre_classification(records, source_items, decisions,
                             decision_field, irrelevant_value,
                             reason_field=None):
    """Mutate records in place: for items the pre-classifier flagged 'irrelevant',
    set the given decision field to the irrelevant_value and optionally append a
    reason to the given notes field. records and source_items are parallel lists —
    source_items is what went INTO pre_classify; records is what goes INTO Airtable."""
    if not decisions:
        return 0
    skipped = 0
    for rec, dec in zip(records, decisions):
        if dec.get("decision") != "irrelevant":
            continue
        rec[decision_field] = irrelevant_value
        if reason_field:
            suffix = f"[Pre-classified {irrelevant_value}: {dec.get('reason', 'irrelevant')}]"
            existing = rec.get(reason_field, "")
            rec[reason_field] = f"{existing}\n{suffix}".strip() if existing else suffix
        skipped += 1
    return skipped


def at_update(base, table, updates, key_token):
    """updates = [{"id": recX, "fields": {...}}]"""
    if not updates:
        return 0
    headers = {"Authorization": f"Bearer {key_token}",
               "Content-Type": "application/json"}
    url = f"https://api.airtable.com/v0/{base}/{table}"
    done = 0
    for i in range(0, len(updates), 10):
        payload = {"records": updates[i:i + 10], "typecast": True}
        status, body = http(url, method="PATCH", headers=headers, body=payload)
        if status >= 400:
            print(f"WARN airtable update {table}: {status} {body[:500]!r}", file=sys.stderr)
            continue
        done += len(json.loads(body).get("records", []))
        time.sleep(SLEEP)
    return done


# ---------- Collectors ----------

def collect_platform_updates(at_key, gh_token, today, openrouter_key=None):
    """Read Monitored Platforms from Airtable, dispatch to the right fetcher
    based on Check Method, write findings to Platform Updates, and update
    Last Checked / Last Finding Date on each platform row."""

    platforms = at_list_all(
        AIRTABLE_BASE, TABLE_MONITORED,
        [F_M_NAME, F_M_TIER, F_M_METHOD, F_M_SOURCE_URL, F_M_ACTIVE],
        at_key,
    )
    active = [p for p in platforms if (p.get("fields") or {}).get(F_M_ACTIVE)]
    print(f"platforms: {len(active)} active of {len(platforms)} total")

    seen = at_existing_titles(AIRTABLE_BASE, TABLE_PLATFORM, F_P_TITLE, at_key)

    new_records = []
    platform_updates = []

    for p in active:
        f = p.get("fields", {}) or {}
        name = f.get(F_M_NAME, "")
        tier = f.get(F_M_TIER, "")
        method = f.get(F_M_METHOD, "")
        source_url = f.get(F_M_SOURCE_URL, "")

        items = []
        if method == "GitHub Releases":
            repo = extract_gh_repo(source_url)
            if repo:
                items = gh_releases(repo, gh_token)
        elif method == "RSS":
            if source_url:
                status, body = http(source_url)
                if status < 400:
                    items = parse_feed(body)
                else:
                    print(f"WARN rss {name}: {status}", file=sys.stderr)
        elif method == "Manual":
            # Tracked in table but we don't auto-fetch. Just bump Last Checked.
            platform_updates.append({"id": p["id"], "fields": {F_M_LAST_CHECKED: today}})
            continue

        platform_new = 0
        for it in items:
            title = f"[{name}] {it['title']}"[:250]
            if title.strip().lower() in seen:
                continue
            seen.add(title.strip().lower())
            fields = {
                F_P_TITLE:      title,
                F_P_PLATFORM:   name,
                F_P_TIER:       tier,
                F_P_DATE_FOUND: today,
                F_P_SUMMARY:    it.get("summary", ""),
                F_P_SOURCE_URL: it.get("link", ""),
                F_P_DECISION:   "Pending",
            }
            d = parse_date(it.get("date"))
            if d:
                fields[F_P_DATE_SHIP] = d
            new_records.append(fields)
            platform_new += 1

        update_fields = {F_M_LAST_CHECKED: today}
        if platform_new > 0:
            update_fields[F_M_LAST_FINDING] = today
        platform_updates.append({"id": p["id"], "fields": update_fields})

    # Pre-classify before upsert. Source_items carry the title/summary used for
    # classification; new_records are the actual Airtable payloads we mutate.
    source_items = [{"title": r[F_P_TITLE], "summary": r.get(F_P_SUMMARY, "")} for r in new_records]
    decisions = pre_classify(source_items, openrouter_key)
    skipped = apply_pre_classification(
        new_records, source_items, decisions,
        F_P_DECISION, "Ignore",
        # Platform Updates has no Notes field; leave reason_field unused
    )
    print(f"platform pre-classify: auto-Ignored {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_PLATFORM, new_records, at_key)
    at_update(AIRTABLE_BASE, TABLE_MONITORED, platform_updates, at_key)
    print(f"platform: {created} created (of {len(new_records)} candidates)")
    print(f"monitored_platforms: {len(platform_updates)} Last Checked dates updated")


def collect_ai_news(at_key, today, openrouter_key=None):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_NEWS, F_N_HEADLINE, at_key)
    records = []
    source_items = []
    for it in hn_top(AI_KEYWORDS):
        title = it["title"][:250]
        if title.strip().lower() in seen:
            continue
        seen.add(title.strip().lower())
        fields = {
            F_N_HEADLINE:   title,
            F_N_SOURCE:     "Hacker News",
            F_N_SOURCE_URL: it["link"],
            F_N_DATE_FOUND: today,
            F_N_SUMMARY:    it.get("summary", ""),
            F_N_DECISION:   "Pending",
        }
        d = parse_date(it.get("date"))
        if d:
            fields[F_N_DATE_PUB] = d
        records.append(fields)
        source_items.append({"title": title, "summary": it.get("summary", "")})

    decisions = pre_classify(source_items, openrouter_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_N_DECISION, "Dismiss", F_N_NOTES,
    )
    print(f"ai_news pre-classify: auto-Dismissed {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_NEWS, records, at_key)
    print(f"ai_news: {created} created (of {len(records)} candidates)")


def collect_deals(at_key, today, openrouter_key=None):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_DEALS, F_D_NAME, at_key)
    records = []
    source_items = []
    status, body = http("https://www.producthunt.com/feed")
    if status < 400:
        kw_lc = [k.lower() for k in DEAL_KEYWORDS]
        for it in parse_feed(body)[:50]:
            title = it["title"][:250]
            combined = (title + " " + (it.get("summary") or "")).lower()
            if not any(k in combined for k in kw_lc):
                continue
            if title.strip().lower() in seen:
                continue
            seen.add(title.strip().lower())
            records.append({
                F_D_NAME:       title,
                F_D_SOURCE:     "ProductHunt",
                F_D_SOURCE_URL: it["link"],
                F_D_DATE_FOUND: today,
                F_D_DESC:       it.get("summary", ""),
                F_D_DECISION:   "Pending",
            })
            source_items.append({"title": title, "summary": it.get("summary", "")})
    else:
        print(f"WARN producthunt rss: {status}", file=sys.stderr)

    decisions = pre_classify(source_items, openrouter_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_D_DECISION, "Skip", F_D_NOTES,
    )
    print(f"deals pre-classify: auto-Skipped {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_DEALS, records, at_key)
    print(f"deals: {created} created (of {len(records)} candidates)")


def collect_skills(at_key, gh_token, today, openrouter_key=None):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_SKILLS, F_S_NAME, at_key)
    records = []
    stats = {"topic": 0, "watched": 0, "awesome": 0}

    # 1. GitHub topic search
    for topic in SKILL_TOPICS:
        for it in gh_topic_search(topic, gh_token):
            name = it["title"][:250]
            if name.strip().lower() in seen:
                continue
            seen.add(name.strip().lower())
            records.append({
                F_S_NAME:       name,
                F_S_TYPE:       "Discovered",
                F_S_SOURCE:     f"GitHub topic:{topic}",
                F_S_SOURCE_URL: it["link"],
                F_S_DESC:       it.get("summary", ""),
                F_S_DATE_FOUND: today,
            })
            stats["topic"] += 1

    # 2. Specific watched repos (always add, even if quiet)
    for repo in WATCHED_SKILL_REPOS:
        info = gh_repo_info(repo, gh_token)
        if not info:
            continue
        name = info["title"][:250]
        if name.strip().lower() in seen:
            continue
        seen.add(name.strip().lower())
        records.append({
            F_S_NAME:       name,
            F_S_TYPE:       "Discovered",
            F_S_SOURCE:     "GitHub watched repo",
            F_S_SOURCE_URL: info["link"],
            F_S_DESC:       info["summary"],
            F_S_DATE_FOUND: today,
        })
        stats["watched"] += 1

    # 3. Awesome-list aggregators (parse README markdown)
    for list_repo in AWESOME_SKILL_LISTS:
        content = gh_readme(list_repo, gh_token)
        if not content:
            continue
        entries = parse_awesome_list(content)
        print(f"awesome-list {list_repo}: parsed {len(entries)} GH repo links")
        for entry in entries:
            name = entry["title"][:250]
            if name.strip().lower() in seen:
                continue
            seen.add(name.strip().lower())
            records.append({
                F_S_NAME:       name,
                F_S_TYPE:       "Discovered",
                F_S_SOURCE:     f"Awesome list: {list_repo}",
                F_S_SOURCE_URL: entry["link"],
                F_S_DESC:       entry.get("summary", ""),
                F_S_DATE_FOUND: today,
            })
            stats["awesome"] += 1

    # Skills uses Type (not Decision) as its state field. Pre-classifier irrelevants
    # get Type=Rejected instead of staying Discovered.
    source_items = [{"title": r[F_S_NAME], "summary": r.get(F_S_DESC, "")} for r in records]
    decisions = pre_classify(source_items, openrouter_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_S_TYPE, "Rejected", F_S_AUDIT_NOTES,
    )
    print(f"skills pre-classify: auto-Rejected {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_SKILLS, records, at_key)
    print(
        f"skills: {created} created "
        f"(of {len(records)} candidates — topic={stats['topic']}, "
        f"watched={stats['watched']}, awesome={stats['awesome']})"
    )


def collect_apis(at_key, today, openrouter_key=None):
    """Fetch from public-apis README + publicapis.dev API, filter by relevant
    categories, upsert to APIs table."""

    # Source 1: public-apis GitHub README
    readme_entries = public_apis_readme()
    print(f"public-apis README: {len(readme_entries)} total entries parsed")

    # Source 2: publicapis.dev (no public API; placeholder for future enhancement)
    dev_entries = publicapis_dev()

    # Merge + dedup by URL (same API appears in both sources under slightly
    # different names sometimes)
    by_url = {}
    for e in readme_entries + dev_entries:
        url = (e.get("url") or "").strip().rstrip("/")
        if not url or url in by_url:
            continue
        by_url[url] = e
    all_entries = list(by_url.values())

    # Filter to relevant categories
    relevant = [e for e in all_entries if e.get("category") in API_CATEGORIES_RELEVANT]
    print(f"APIs: {len(relevant)} in relevant categories after merge "
          f"({len(all_entries)} total unique)")

    seen = at_existing_titles(AIRTABLE_BASE, TABLE_APIS, F_A_NAME, at_key)
    records = []
    for e in relevant:
        name = (e.get("name") or "")[:250]
        if not name or name.strip().lower() in seen:
            continue
        seen.add(name.strip().lower())
        records.append({
            F_A_NAME:           name,
            F_A_MARKETPLACE:    "public-apis",
            F_A_MARKETPLACE_URL:e.get("url", ""),
            F_A_DATE_FOUND:     today,
            F_A_CATEGORY:       e.get("category", ""),
            F_A_DESCRIPTION:    (e.get("description") or "")[:SUMMARY_CAP],
            F_A_FREE_TIER:      f"Auth: {e.get('auth','?')} | HTTPS: {e.get('https','?')}",
            F_A_STATUS:         "Discovered",
            F_A_DECISION:       "Pending",
        })
    # APIs has no Notes field. Pass None for reason_field; just set Decision.
    source_items = [{"title": r[F_A_NAME], "summary": r.get(F_A_DESCRIPTION, "")} for r in records]
    decisions = pre_classify(source_items, openrouter_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_A_DECISION, "Skip",
    )
    print(f"apis pre-classify: auto-Skipped {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_APIS, records, at_key)
    print(f"apis: {created} created (of {len(records)} candidates)")


def collect_hf_trending(at_key, today, openrouter_key=None):
    """Pull HF trending models into AI News as 'HuggingFace Trending' source."""
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_NEWS, F_N_HEADLINE, at_key)
    records = []
    for it in hf_trending_models():
        title = it["title"][:250]
        if title.strip().lower() in seen:
            continue
        seen.add(title.strip().lower())
        fields = {
            F_N_HEADLINE:   title,
            F_N_SOURCE:     "HuggingFace Trending",
            F_N_SOURCE_URL: it["link"],
            F_N_DATE_FOUND: today,
            F_N_SUMMARY:    it.get("summary", ""),
            F_N_DECISION:   "Pending",
        }
        d = parse_date(it.get("date"))
        if d:
            fields[F_N_DATE_PUB] = d
        records.append(fields)

    source_items = [{"title": r[F_N_HEADLINE], "summary": r.get(F_N_SUMMARY, "")} for r in records]
    decisions = pre_classify(source_items, openrouter_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_N_DECISION, "Dismiss", F_N_NOTES,
    )
    print(f"hf_trending pre-classify: auto-Dismissed {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_NEWS, records, at_key)
    print(f"hf_trending: {created} created (of {len(records)} candidates)")


# ---------- Main ----------

def main():
    at_key = os.environ["AIRTABLE_API_KEY"]
    gh_token = os.environ["TRIAGE_GH_TOKEN"]
    today = datetime.now(timezone.utc).date().isoformat()
    print(f"intel-collector run: {today}")
    print(f"DEBUG: AIRTABLE_API_KEY len={len(at_key)} suffix=...{at_key[-4:]}")
    print(f"DEBUG: TRIAGE_GH_TOKEN  len={len(gh_token)} suffix=...{gh_token[-4:]}")

    openrouter_key = get_openrouter_key_from_airtable(at_key)

    collect_platform_updates(at_key, gh_token, today, openrouter_key)
    collect_ai_news(at_key, today, openrouter_key)
    collect_hf_trending(at_key, today, openrouter_key)
    collect_deals(at_key, today, openrouter_key)
    collect_skills(at_key, gh_token, today, openrouter_key)
    collect_apis(at_key, today, openrouter_key)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
