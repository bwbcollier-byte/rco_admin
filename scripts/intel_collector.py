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

TABLE_MONITORED = "tblRzDbDhgH4cv0s9"  # April 2026: was tbldabNFfzcs35YXn; now Stack & Platforms
TABLE_PLATFORM  = "tblW6XV9X5gBrghOv"
TABLE_NEWS      = "tbl4IUWP09vzchU5t"
TABLE_DEALS     = "tbl9a3WVIhW7NddYz"
TABLE_SKILLS    = "tblRYHxXNItKHXqg7"
TABLE_APIS      = "tblhsuuFCDKmO1Ho3"

# Monitored Platforms — now sourced from Stack & Platforms (April 2026 consolidation)
# Only rows with Check Method set are treated as monitored platforms.
F_M_NAME         = "fldFBxTY9K1nBbt4W"  # primary — was fldweyAemSTkEb3ej
F_M_TIER         = "fldYwsD7XoMII9r9b"  # Tier — was fldRNBPsWXEwqkeuw
F_M_METHOD       = "fldWSk9Pzp5QcvqYt"  # Check Method — was fldF6kdxfXCFNaR40
F_M_SOURCE_URL   = "fld8MFuN45W7Gqhpi"  # Source URL — was fldtZLPqZX9BVk2dn
F_M_CATEGORY     = "fldY8K22GUDevl0RK"  # Category — was fldMwWlXmDYfoiNhR
F_M_ACTIVE       = "fldBW4YyH9LackB0o"  # Active checkbox — was fldiYywh64gn9BBl0
F_M_LAST_CHECKED = "fldpBy6Uj6M1LXRes"  # Last Checked — was fld048If9pGGu3aX3
F_M_LAST_FINDING = "fld80Rg77nYLesKwG"  # Last Finding Date — was fldsQ8hr2qcN2b3h3

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

# ---------- Intel Feed (consolidated April 2026) ----------
# Replaces TABLE_PLATFORM (tblW6XV9X5gBrghOv), TABLE_NEWS (tbl4IUWP09vzchU5t),
# TABLE_DEALS (tbl9a3WVIhW7NddYz). Discriminate rows by F_IF_FEED_TYPE value.

TABLE_INTEL_FEED   = "tblwX27CIfhUPAm7J"
F_IF_TITLE         = "fldz126GxHrT2LNvd"  # primary (was Update Title / Headline / Product Name)
F_IF_FEED_TYPE     = "fldOJjF4CHVFUTDnI"  # singleSelect: Platform Update | AI News | Deal | YouTube
F_IF_SOURCE        = "fldVDf9XduKHz0cnD"  # platform name / news source / deal source
F_IF_SOURCE_URL    = "fldbuIajYp1uKV9Fu"
F_IF_DATE_PUB      = "fldMZ7WODZpKGY54f"  # date the item was published / shipped
F_IF_DATE_FOUND    = "fldhHCyKchpTnLn5H"  # date collector added it
F_IF_SUMMARY       = "fldbaO4lSEliQTnAP"  # raw summary from source
F_IF_DESCRIPTION   = "fldtNIUixmSbBmgUt"  # enriched description (Gemini fills)
F_IF_WHY           = "flddwIXL5VxOkSLPN"  # Why It Matters (Gemini fills)
F_IF_USE_CASE_1    = "fldp60fJmcVtZ59gO"  # (Gemini fills)
F_IF_USE_CASE_2    = "fldtgGmMFPg745cPA"  # (Gemini fills)
F_IF_PLATFORM_TIER = "fldUvWNsQiHPN8kP6"  # singleSelect (Platform Update rows)
F_IF_EFFORT        = "fldyjfqlLKJmr50Jr"  # singleSelect S/M/L (Gemini fills)
F_IF_RELEVANCE     = "fldCv4CQsqJJPRD0a"  # singleSelect High/Medium/Low (Gemini fills)
F_IF_DECISION      = "fldvbbRANVEpL37MA"  # singleSelect — values vary by Feed Type
F_IF_NOTES         = "fldM8wNT4PV0OcC9J"  # pre-classifier reasons, misc notes

# ---------- APIs table (rebuilt April 2026 — old tblhsuuFCDKmO1Ho3 is gone) ----------

TABLE_APIS_V2      = "tblMb9HFyKcnQ7aKb"
F_A2_NAME          = "fldgEt7Po7CBXvA71"  # primary (singleLineText)
F_A2_DEVELOPER     = "fldtr3JUxQpvkb4us"  # developer / provider name
F_A2_LINK          = "fld0SuLIJPIGM4UTY"  # API URL / docs link
F_A2_SOURCE        = "fldpkzrWeLnWVGbIK"  # singleSelect: public-apis | RapidAPI | etc.
F_A2_ABOUT         = "fld6t5xv5ejuni3pI"  # description (category is embedded as [Cat] prefix)
F_A2_DATE_FOUND    = "fldstJZi2oybRW4rj"  # date
F_A2_STATUS        = "fldFSB4dK0bVRbt0R"  # singleSelect
F_A2_DECISION      = "fldbpVmC9myu1dk0T"  # singleSelect
F_A2_FREE_TIER     = "fldh0ShjqkmK66aM2"  # free tier details text
F_A2_INT_POTENTIAL = "fldv71991pgCAkOpc"  # Integration Potential (Gemini fills)
F_A2_WHAT_ENHANCES = "fld2j32xe7ZLzKbCi"  # What It Enhances (Gemini fills)

# ---------- Gemini AI evaluation config ----------
# Used by evaluate_pending_skills() and evaluate_pending_intel_feed().
# Key is loaded from Airtable Logins & Keys ("Google Gemini" row) or GEMINI_API_KEY env var.

GEMINI_MODEL          = "gemini-2.5-flash-lite"
GEMINI_URL            = (
    f"https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
GEMINI_EVAL_BATCH_SIZE = 12   # ~13 RPM — safely inside free-tier 15 RPM limit
GEMINI_SLEEP           = 4.5  # seconds between batches

# Logins & Keys
TABLE_LOGINS_KEYS = "tbldJkG11gY1W3jTf"
F_LK_NAME         = "fldQqf8eF4mT2U0zT"  # primary
F_LK_KEYS         = "fld4fYgMypJz9Iete"
F_LK_STATUS       = "fldcZ9nAY8GD2OZW8"

# Action Items (used when the collector needs to self-report a problem)
TABLE_ACTION_ITEMS = "tblWFVbz8tllvcgIF"
F_AI_ACTION        = "fldtKkNfE6ZpSuAdd"  # primary
F_AI_SOURCE        = "fldHQCWDP2EOTxXTJ"
F_AI_SOURCE_SECTION= "fld0jXPFky2At7LIN"
F_AI_DATE_CREATED  = "fldqGpqlKzlTXZxPP"
F_AI_PRIORITY      = "fldpYhte8p5fsPAey"
F_AI_EFFORT        = "fldebPAeRXgknu9Rj"
F_AI_STATUS        = "fldvLadckj0xikIlP"
F_AI_DESCRIPTION   = "fldGdcdsWCj5pbuGG"
F_AI_PROMPT        = "fld4fQIGmD6JPIQft"

# AI Models catalog
TABLE_AI_MODELS   = "tblzehtQS5H1TKlSP"  # April 2026: was tblzsfFK5MBZHIpAk
F_AM_NAME         = "fld6jUxZU7GxcMXI3"  # primary
F_AM_SLUG         = "fldizUTyLsnhr78ZV"
F_AM_PROVIDER     = "fldXvFvoXUaJqLFjF"
F_AM_VIA          = "fldVxTy5zzxuDRkdg"
F_AM_TIER         = "fldWO9vh1SpDKBAhZ"
F_AM_INPUT_PRICE  = "fldMJYdF0Xoq3Zj4j"
F_AM_OUTPUT_PRICE = "fldlHfoMzTu7a4efE"
F_AM_CONTEXT      = "fld1WHR1GShSvE1lf"
F_AM_GOOD_FOR     = "fldn1iqpsvbALL2P7"
F_AM_QUALITY      = "fldfCssQtvnITdUsu"
F_AM_STATUS       = "fldS8tdNRrEaKfl1W"
F_AM_CURRENT_USE  = "fldu8c2337zeAaR3q"
F_AM_LAST_CHECKED = "fldKPsV3LzTay0uMp"
F_AM_FIRST_FOUND  = "fldtOn58LpHE9iSIx"
F_AM_NOTES        = "fldyJklFGPg5tuTyn"

# OpenRouter pre-classifier config
# Default model only used if no AI Models row is marked `Currently In Use For` =
# 'intel pre-classifier'. Qwen 2.5 72B free is the current default.
OPENROUTER_MODEL = "qwen/qwen-2.5-72b-instruct:free"
OPENROUTER_URL   = "https://openrouter.ai/api/v1/chat/completions"
PRE_CLASSIFY_BATCH_SIZE = 15

# Providers worth tracking in AI Models. OpenRouter's catalog has 300+ models
# across many providers; we only upsert rows for these to keep the table focused.
INTERESTING_MODEL_PROVIDERS = {
    "anthropic", "openai", "google", "meta-llama", "qwen", "deepseek",
    "mistralai", "cohere", "perplexity", "x-ai", "nvidia", "amazon",
    "microsoft", "nousresearch",
}

# AI Apps catalog
TABLE_AI_APPS      = "tblEUsS2yfNn7msBB"
F_APP_NAME         = "fldBhQapkkLZssBwJ"   # primary
F_APP_CATEGORY     = "fld9tbdXX6ogYPE7k"
F_APP_SUBCATEGORY  = "fldPLasEpXGHNX04k"
F_APP_DESCRIPTION  = "fldiEo5zsH7snTCV8"
F_APP_COMPANY      = "fldEbinfxNOQGwkAw"
F_APP_URL          = "fldRNXGpPwqoRlkvs"
F_APP_PRICING_TIER = "fldnSTZC1jxKJASvZ"
F_APP_STATUS       = "fldw4yXEwE3I5tRBi"
F_APP_GOOD_FOR     = "fldlUZuWrVYTZtDbN"
F_APP_DATE_FOUND   = "fld8suP8BipYDENXQ"
F_APP_LAST_CHECKED = "fldeQ8FaJhQamsVrd"
F_APP_NOTES        = "flddowUuV49VJBP2O"

# AI Apps discovery: sitemap-driven, per-run cap to avoid flood.
APP_SITEMAPS = [
    # (source_label, sitemap_url, title_cleaner_prefix, title_cleaner_suffix_re)
    ("FutureTools",
     "https://futuretools.io/sitemap.xml",
     "Future Tools - ",
     None,
     "/tools/"),
    ("Futurepedia",
     "https://www.futurepedia.io/sitemap_tools.xml",
     None,
     r"\s+AI Reviews.*$",
     "/tool/"),
]
AI_APPS_MAX_NEW_PER_RUN = 40     # cap per site per run — 40 × 2 sites = 80 scrapes max
AI_APPS_SCRAPE_DELAY    = 0.5    # polite sleep between tool-page fetches

# HuggingFace model collection config
HF_PIPELINE_TAGS = [
    "text-generation",
    "text-to-image",
    "text-to-video",
    "text-to-speech",
    "automatic-speech-recognition",
    "feature-extraction",       # embeddings
    "image-text-to-text",       # multimodal
    "image-to-image",
]
HF_MODELS_PER_TASK = 25

HF_TAG_TO_GOOD_FOR = {
    "text-generation":              ["Reasoning"],
    "text-to-image":                ["Image Generation"],
    "text-to-video":                ["Video Generation"],
    "text-to-speech":               ["Voice"],
    "automatic-speech-recognition": ["Voice"],
    "feature-extraction":           ["Embeddings"],
    "image-text-to-text":           ["Multimodal"],
    "image-to-image":               ["Multimodal"],
    "image-to-text":                ["Multimodal"],
    "translation":                  ["Translation"],
    "summarization":                ["Summarization"],
    "question-answering":           ["Research"],
}

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


def create_collector_action_item(at_key, action, description, prompt,
                                 priority="High", effort="S",
                                 source_section="OpenRouter classifier"):
    """File a 'New' Action Item about a collector self-reported issue.

    Dedupes against existing Action Items with the same Action (primary key)
    and Status ∈ {New, In Progress, Blocked, Carried Forward} — doesn't create
    a duplicate if the same issue is already open.
    """
    try:
        existing = at_list_all(
            AIRTABLE_BASE, TABLE_ACTION_ITEMS,
            [F_AI_ACTION, F_AI_STATUS], at_key,
        )
    except Exception as e:
        print(f"WARN collector self-report dedup lookup: {e}", file=sys.stderr)
        existing = []
    target_action = action.strip().lower()
    open_statuses = {"new", "in progress", "blocked", "carried forward"}
    for r in existing:
        f = r.get("fields", {}) or {}
        row_action = (f.get(F_AI_ACTION) or "").strip().lower()
        status_val = f.get(F_AI_STATUS)
        if isinstance(status_val, dict):
            status_name = (status_val.get("name") or "").lower()
        else:
            status_name = (status_val or "").lower()
        if row_action == target_action and status_name in open_statuses:
            print(f"collector self-report: '{action[:60]}' already open — skipping create",
                  file=sys.stderr)
            return None

    today = datetime.now(timezone.utc).date().isoformat()
    fields = {
        F_AI_ACTION:        action,
        F_AI_SOURCE:        "Collector Self-Report",
        F_AI_SOURCE_SECTION:source_section,
        F_AI_DATE_CREATED:  today,
        F_AI_PRIORITY:      priority,
        F_AI_EFFORT:        effort,
        F_AI_STATUS:        "New",
        F_AI_DESCRIPTION:   description,
        F_AI_PROMPT:        prompt,
    }
    created = at_create(AIRTABLE_BASE, TABLE_ACTION_ITEMS, [fields], at_key)
    if created:
        print(f"collector self-report: filed Action Item '{action[:60]}'")
    return created


def create_collector_action_item_model_not_found(at_key, model_slug, error_excerpt):
    """Specialized Action Item for 'classifier model slug no longer exists'."""
    action = (
        f"OpenRouter: classifier model '{model_slug}' returned 404 — "
        f"update AI Models row to a currently-available slug"
    )
    description = (
        f"The intel collector's configured classifier model is no longer available "
        f"on OpenRouter. HTTP 404 response (excerpt): {error_excerpt[:250]}\n\n"
        f"Effect: pre-classifier is disabled for this run. ALL new items pass through "
        f"to Claude's brief review on Monday (~4-5x cost increase).\n\n"
        f"Fix: in Airtable base app6biS7yjV6XzFVG, table 'AI Models', find the row "
        f"where 'Currently In Use For' contains 'intel pre-classifier'. Update its "
        f"Slug field to a currently-live model. See OpenRouter's live model list "
        f"(https://openrouter.ai/api/v1/models — filter for :free if free tier preferred)."
    )
    prompt = (
        "First, read /Users/ben/Documents/Claude OS/Work/Engineering Ops/prompts/hypebase-primer.md for project context. Then:\n\n"
        "Task: Replace the deprecated classifier model slug in the Airtable AI Models table.\n\n"
        "Steps:\n"
        "1. Open Airtable base `app6biS7yjV6XzFVG`, table 'AI Models'\n"
        "2. Find the row where `Currently In Use For` contains 'intel pre-classifier'\n"
        f"3. Current slug (no longer live on OpenRouter): {model_slug}\n"
        "4. Fetch current model list:\n"
        "   `curl -s https://openrouter.ai/api/v1/models | "
        "python3 -c \"import json,sys; [print(m['id']) for m in "
        "json.load(sys.stdin)['data'] if m['id'].endswith(':free')]\"`\n"
        "5. Pick a suitable replacement. Criteria (in priority order):\n"
        "   - General instruct model (not code-specific, not vision)\n"
        "   - 30B+ parameters ideally\n"
        "   - Stable (avoid ':preview' or ':nightly' variants)\n"
        "   - Free tier preferred (matches current setup) — otherwise pick cheap paid\n"
        "6. Update the Slug field on the Airtable row\n"
        "7. Also update Name, Notes to reflect the new model\n\n"
        "Done criteria:\n"
        "- AI Models row updated to a currently-available model slug\n"
        "- Next intel-collector run completes with no 'No endpoints found' WARN in logs\n"
        "- This Action Item Status = Done, Outcome = 'Swapped to <new-slug>'"
    )
    return create_collector_action_item(
        at_key, action, description, prompt,
        priority="High", effort="S",
        source_section="OpenRouter classifier model deprecated",
    )


def create_collector_action_item_keys_exhausted(at_key, exhausted):
    """Specialized Action Item for 'all OpenRouter keys exhausted' scenario."""
    action = (
        f"OpenRouter: all {len(exhausted)} account key(s) are rate-limited or "
        f"exhausted — provide a new account key"
    )
    exhaust_lines = "\n".join(
        f"- key suffix ...{e['suffix']}: HTTP {e['status']}"
        for e in exhausted
    )
    description = (
        f"The intel collector hit rate-limit / quota / auth errors on every configured "
        f"OpenRouter key during pre-classification. Without a working key, the Monday "
        f"intel brief reviews ALL Pending items with Claude Sonnet (expensive) instead "
        f"of only survivors (~75% cost increase).\n\n"
        f"Retired keys this run:\n{exhaust_lines}\n\n"
        f"Fix: create a new OpenRouter account + API key, add the key to the "
        f"Airtable Logins & Keys 'Open Router' row's Keys field "
        f"(append a new 'email:\\nsk-or-...' block), save. Next collector run picks it up."
    )
    prompt = (
        "First, read /Users/ben/Documents/Claude OS/Work/Engineering Ops/prompts/hypebase-primer.md for project context. Then:\n\n"
        "Task: Add a new OpenRouter account key to the Airtable Logins & Keys rotation "
        "so the intel collector's pre-classifier keeps working.\n\n"
        "Steps:\n"
        "1. Go to https://openrouter.ai/ and sign up with a new email (you have previous "
        "accounts noted in Airtable Logins & Keys 'Open Router' row — use a different one)\n"
        "2. Visit https://openrouter.ai/keys and create a key named "
        "'HypeBase intel collector - rotation N' (where N is the next unused index)\n"
        "3. Copy the key (`sk-or-v1-...`)\n"
        "4. Open Airtable base app6biS7yjV6XzFVG, table 'Logins & Keys', row 'Open Router'. "
        "Edit the Keys field and APPEND a new block at the bottom:\n"
        "   ```\n   <new-email>:\n   sk-or-v1-<pasted-key>\n   ```\n"
        "5. Save. The collector loads all keys from this field on next run and falls "
        "through them on rate-limit.\n\n"
        "Done criteria:\n"
        "- Airtable Logins & Keys 'Open Router' row has N+1 keys in its Keys field "
        "(visible as additional sk-or- lines)\n"
        "- This Action Item Status = Done, Outcome = 'Added rotation key ...XXXX "
        "(suffix of new key) from <email>'"
    )
    return create_collector_action_item(
        at_key, action, description, prompt,
        priority="High", effort="S",
        source_section="OpenRouter key rotation exhausted",
    )


def get_openrouter_keys_from_airtable(at_key):
    """Fetch ALL OpenRouter keys from the Airtable Logins & Keys table.

    Searches rows whose Name matches any OpenRouter variant and extracts every
    line starting with 'sk-or-' from the Keys field. Supports multiple keys
    per row (email-prefixed pattern like Tavily uses) and multiple rows.

    Falls back to OPENROUTER_API_KEY env var if Airtable lookup yields nothing.
    Returns a (possibly empty) list. Never logs the values.
    """
    keys = []
    seen = set()  # de-dup across rows
    try:
        rows = at_list_all(
            AIRTABLE_BASE, TABLE_LOGINS_KEYS, [F_LK_NAME, F_LK_KEYS], at_key
        )
    except Exception as e:
        print(f"WARN openrouter keys airtable lookup: {e}", file=sys.stderr)
        rows = []
    for r in rows:
        f = r.get("fields", {}) or {}
        name = (f.get(F_LK_NAME) or "").strip().lower().replace(" ", "")
        if name not in ("openrouter", "open-router", "openrouterapikey"):
            continue
        keys_text = f.get(F_LK_KEYS) or ""
        for line in keys_text.splitlines():
            line = line.strip()
            if line.startswith("sk-or-") and line not in seen:
                keys.append(line)
                seen.add(line)
    if not keys:
        env_val = (os.environ.get("OPENROUTER_API_KEY") or "").strip()
        if env_val and env_val not in seen:
            keys.append(env_val)
            print(f"openrouter keys: loaded 1 from env (suffix=...{env_val[-4:]})")
            return keys
        print("WARN openrouter: no keys found in Airtable or env — pre-classifier disabled",
              file=sys.stderr)
        return []
    print(f"openrouter keys: loaded {len(keys)} from Airtable (suffixes: " +
          ", ".join(f"...{k[-4:]}" for k in keys) + ")")
    return keys


def get_classifier_model_from_airtable(at_key):
    """Find the slug for the intel pre-classifier in AI Models table.

    Matches rows where `Currently In Use For` contains 'intel pre-classifier'
    (case-insensitive). Returns the Slug value of the first match, or falls
    back to the OPENROUTER_MODEL constant.
    """
    try:
        rows = at_list_all(AIRTABLE_BASE, TABLE_AI_MODELS,
                           [F_AM_SLUG, F_AM_CURRENT_USE], at_key)
    except Exception as e:
        print(f"WARN classifier model lookup: {e}", file=sys.stderr)
        return OPENROUTER_MODEL
    for r in rows:
        f = r.get("fields", {}) or {}
        use = (f.get(F_AM_CURRENT_USE) or "").lower()
        if "intel pre-classifier" in use or "pre-classifier" in use:
            slug = (f.get(F_AM_SLUG) or "").strip()
            if slug:
                print(f"classifier model from Airtable: {slug}")
                return slug
    print(f"classifier model (fallback to default constant): {OPENROUTER_MODEL}")
    return OPENROUTER_MODEL


def pre_classify(items, openrouter_keys, model=None, at_key=None):
    """Batch-classify items via OpenRouter. Takes a LIST of keys and rotates on
    rate-limit / quota errors. Returns list of dicts in input order:
    [{'decision': 'relevant'|'irrelevant'|'maybe', 'reason': str}, ...].

    Safe to call with empty keys list or empty items. On any failure, returns
    'maybe' for every item so nothing gets auto-dismissed on classifier errors.

    If ALL keys are exhausted (all hitting 429/402/403), files a 'New' Action
    Item in Airtable asking the user to provide a new account key, then returns
    'maybe' for the remaining items.
    """
    if not items or not openrouter_keys:
        return [{"decision": "maybe", "reason": "classifier disabled"} for _ in items]

    # Backward compat: accept a single key string too
    if isinstance(openrouter_keys, str):
        openrouter_keys = [openrouter_keys]

    model_slug = model or OPENROUTER_MODEL
    available_keys = list(openrouter_keys)
    exhausted = []  # track which keys have been retired for this run
    current_key_idx = 0

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
        body = json.dumps({
            "model": model_slug,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 1500,
            "temperature": 0,
        }).encode()

        # Try keys in order. 429 (rate limit), 402 (insufficient credits),
        # 403 (invalid/revoked key), 401 (auth failure) → retire key for this
        # run, try next. 404 "No endpoints found" is a model-availability
        # problem, not a key problem — handled separately below.
        RETIRE_STATUSES = {401, 402, 403, 429}
        status = 0
        resp_body = b""
        while current_key_idx < len(available_keys):
            key = available_keys[current_key_idx]
            headers = {
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/bwbcollier-byte/rco_admin",
                "X-Title": "HypeBase Intel Collector",
            }
            status, resp_body = http(OPENROUTER_URL, method="POST", headers=headers, body=body)
            if status in RETIRE_STATUSES:
                err_preview = resp_body[:120] if resp_body else b""
                print(
                    f"openrouter key ...{key[-4:]} retired at batch {start}: "
                    f"HTTP {status} — trying next key",
                    file=sys.stderr,
                )
                exhausted.append({"suffix": key[-4:], "status": status,
                                  "error": err_preview.decode('utf-8', errors='replace')})
                current_key_idx += 1
                continue
            break  # success or non-retirement error (incl. 404 model-not-found)

        # 404 'No endpoints found' = configured model slug is gone from OpenRouter.
        # Every subsequent batch will hit the same wall, so fail fast and file an
        # Action Item pointing to the Airtable row that needs updating.
        if status == 404 and b"No endpoints found" in (resp_body or b""):
            err_text = resp_body.decode("utf-8", errors="replace") if resp_body else ""
            print(
                f"WARN pre_classify: model '{model_slug}' returned 404 — bailing out "
                f"and filing Action Item to update the Airtable AI Models row.",
                file=sys.stderr,
            )
            if at_key:
                create_collector_action_item_model_not_found(at_key, model_slug, err_text)
            for i in range(start, len(items)):
                if results[i] is None:
                    results[i] = {"decision": "maybe",
                                  "reason": f"classifier model '{model_slug}' not found"}
            break

        # All keys tried?
        if current_key_idx >= len(available_keys):
            print("WARN pre_classify: ALL OpenRouter keys exhausted — filing Action Item",
                  file=sys.stderr)
            if at_key:
                create_collector_action_item_keys_exhausted(at_key, exhausted)
            # Remaining items get 'maybe'
            for i in range(start, len(items)):
                if results[i] is None:
                    results[i] = {"decision": "maybe", "reason": "all classifier keys exhausted"}
            break  # stop processing further batches

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

    # Fill any stragglers (shouldn't happen, but belt-and-braces)
    for i, r in enumerate(results):
        if r is None:
            results[i] = {"decision": "maybe", "reason": "classifier incomplete"}

    counts = {"relevant": 0, "irrelevant": 0, "maybe": 0}
    for r in results:
        counts[r["decision"]] = counts.get(r["decision"], 0) + 1
    keys_used = min(current_key_idx + 1, len(available_keys)) if available_keys else 0
    print(f"pre_classify: relevant={counts['relevant']} "
          f"irrelevant={counts['irrelevant']} maybe={counts['maybe']} "
          f"(model={model_slug}, {len(items)} items, keys_used={keys_used}/{len(available_keys)})")
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

def collect_platform_updates(at_key, gh_token, today, openrouter_keys=None, classifier_model=None):
    """Read Monitored Platforms from Airtable, dispatch to the right fetcher
    based on Check Method, write findings to Platform Updates, and update
    Last Checked / Last Finding Date on each platform row."""

    platforms = at_list_all(
        AIRTABLE_BASE, TABLE_MONITORED,
        [F_M_NAME, F_M_TIER, F_M_METHOD, F_M_SOURCE_URL, F_M_ACTIVE],
        at_key,
    )
    # Only rows with Active=true AND Check Method set are monitored platforms
    active = [p for p in platforms
              if (p.get("fields") or {}).get(F_M_ACTIVE)
              and (p.get("fields") or {}).get(F_M_METHOD)]
    print(f"platforms: {len(active)} active of {len(platforms)} total")

    # Dedup against Intel Feed (consolidated table — replaces old TABLE_PLATFORM)
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_INTEL_FEED, F_IF_TITLE, at_key)

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
                F_IF_TITLE:         title,
                F_IF_FEED_TYPE:     "Platform Update",
                F_IF_SOURCE:        name,
                F_IF_PLATFORM_TIER: tier,
                F_IF_DATE_FOUND:    today,
                F_IF_SUMMARY:       it.get("summary", ""),
                F_IF_SOURCE_URL:    it.get("link", ""),
                F_IF_DECISION:      "Pending",
            }
            d = parse_date(it.get("date"))
            if d:
                fields[F_IF_DATE_PUB] = d
            new_records.append(fields)
            platform_new += 1

        update_fields = {F_M_LAST_CHECKED: today}
        if platform_new > 0:
            update_fields[F_M_LAST_FINDING] = today
        platform_updates.append({"id": p["id"], "fields": update_fields})

    # Pre-classify before upsert. Source_items carry the title/summary used for
    # classification; new_records are the actual Airtable payloads we mutate.
    source_items = [{"title": r[F_IF_TITLE], "summary": r.get(F_IF_SUMMARY, "")} for r in new_records]
    decisions = pre_classify(source_items, openrouter_keys, classifier_model, at_key=at_key)
    skipped = apply_pre_classification(
        new_records, source_items, decisions,
        F_IF_DECISION, "Ignore",
        # No per-item notes field for Platform Updates; reason dropped intentionally
    )
    print(f"platform pre-classify: auto-Ignored {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_INTEL_FEED, new_records, at_key)
    at_update(AIRTABLE_BASE, TABLE_MONITORED, platform_updates, at_key)
    print(f"platform: {created} created (of {len(new_records)} candidates)")
    print(f"monitored_platforms: {len(platform_updates)} Last Checked dates updated")


def collect_ai_news(at_key, today, openrouter_keys=None, classifier_model=None):
    # Dedup against Intel Feed (replaces old TABLE_NEWS)
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_INTEL_FEED, F_IF_TITLE, at_key)
    records = []
    source_items = []
    for it in hn_top(AI_KEYWORDS):
        title = it["title"][:250]
        if title.strip().lower() in seen:
            continue
        seen.add(title.strip().lower())
        fields = {
            F_IF_TITLE:      title,
            F_IF_FEED_TYPE:  "AI News",
            F_IF_SOURCE:     "Hacker News",
            F_IF_SOURCE_URL: it["link"],
            F_IF_DATE_FOUND: today,
            F_IF_SUMMARY:    it.get("summary", ""),
            F_IF_DECISION:   "Pending",
        }
        d = parse_date(it.get("date"))
        if d:
            fields[F_IF_DATE_PUB] = d
        records.append(fields)
        source_items.append({"title": title, "summary": it.get("summary", "")})

    decisions = pre_classify(source_items, openrouter_keys, classifier_model, at_key=at_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_IF_DECISION, "Dismiss", F_IF_NOTES,
    )
    print(f"ai_news pre-classify: auto-Dismissed {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_INTEL_FEED, records, at_key)
    print(f"ai_news: {created} created (of {len(records)} candidates)")


def collect_deals(at_key, today, openrouter_keys=None, classifier_model=None):
    # Dedup against Intel Feed (replaces old TABLE_DEALS)
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_INTEL_FEED, F_IF_TITLE, at_key)
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
                F_IF_TITLE:       title,
                F_IF_FEED_TYPE:   "Deal",
                F_IF_SOURCE:      "ProductHunt",
                F_IF_SOURCE_URL:  it["link"],
                F_IF_DATE_FOUND:  today,
                F_IF_DESCRIPTION: it.get("summary", ""),
                F_IF_DECISION:    "Pending",
            })
            source_items.append({"title": title, "summary": it.get("summary", "")})
    else:
        print(f"WARN producthunt rss: {status}", file=sys.stderr)

    decisions = pre_classify(source_items, openrouter_keys, classifier_model, at_key=at_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_IF_DECISION, "Skip", F_IF_NOTES,
    )
    print(f"deals pre-classify: auto-Skipped {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_INTEL_FEED, records, at_key)
    print(f"deals: {created} created (of {len(records)} candidates)")


def collect_skills(at_key, gh_token, today, openrouter_keys=None, classifier_model=None):
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
    decisions = pre_classify(source_items, openrouter_keys, classifier_model, at_key=at_key)
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


def dismiss_irrelevant_pending_apis(at_key):
    """Legacy cleanup — superseded by the TABLE_APIS_V2 migration (April 2026).

    The old TABLE_APIS (tblhsuuFCDKmO1Ho3) had a Category field we could filter on.
    TABLE_APIS_V2 (tblMb9HFyKcnQ7aKb) has no Category column — category is embedded
    as a [Cat] prefix in the About field, and collect_apis() already gates new writes
    on API_CATEGORIES_RELEVANT at write time, so irrelevant records never enter the
    new table in the first place.

    This function is kept as a no-op so main() calls don't need to change, but it
    does nothing. Remove the call from main() once the migration is confirmed stable.
    """
    print("dismiss_irrelevant_pending_apis: no-op (TABLE_APIS_V2 uses write-time filtering)")
    return 0


def collect_apis(at_key, today, openrouter_keys=None, classifier_model=None):
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

    # Write to rebuilt APIs table (TABLE_APIS_V2 — old tblhsuuFCDKmO1Ho3 is gone)
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_APIS_V2, F_A2_NAME, at_key)
    records = []
    for e in relevant:
        name = (e.get("name") or "")[:250]
        if not name or name.strip().lower() in seen:
            continue
        seen.add(name.strip().lower())
        # Embed category as [Cat] prefix in About so it's searchable even though
        # the new schema has no dedicated Category column.
        cat = e.get("category", "")
        desc = (e.get("description") or "")[:SUMMARY_CAP]
        about = f"[{cat}] {desc}".strip()[:SUMMARY_CAP] if cat else desc
        records.append({
            F_A2_NAME:      name,
            F_A2_SOURCE:    "public-apis",
            F_A2_LINK:      e.get("url", ""),
            F_A2_DATE_FOUND:today,
            F_A2_ABOUT:     about,
            F_A2_FREE_TIER: f"Auth: {e.get('auth','?')} | HTTPS: {e.get('https','?')}",
            F_A2_STATUS:    "Discovered",
            F_A2_DECISION:  "Pending",
        })
    # New APIs table has no Notes field; pass None for reason_field.
    source_items = [{"title": r[F_A2_NAME], "summary": r.get(F_A2_ABOUT, "")} for r in records]
    decisions = pre_classify(source_items, openrouter_keys, classifier_model, at_key=at_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_A2_DECISION, "Skip",
    )
    print(f"apis pre-classify: auto-Skipped {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_APIS_V2, records, at_key)
    print(f"apis: {created} created (of {len(records)} candidates)")


def fetch_sitemap_entries(url):
    """Parse an XML sitemap. Returns list of {url, lastmod}."""
    status, body = http(url)
    if status >= 400:
        print(f"WARN sitemap {url}: {status}", file=sys.stderr)
        return []
    content = body.decode("utf-8", errors="replace")
    # Per-<url> block with optional <lastmod>
    entries = []
    for block in re.finditer(r"<url>(.*?)</url>", content, re.DOTALL):
        inner = block.group(1)
        loc = re.search(r"<loc>([^<]+)</loc>", inner)
        lastmod = re.search(r"<lastmod>([^<]+)</lastmod>", inner)
        if loc:
            entries.append({
                "url": loc.group(1).strip(),
                "lastmod": (lastmod.group(1).strip() if lastmod else ""),
            })
    return entries


def parse_tool_page(tool_url, prefix_to_strip, suffix_re):
    """Fetch an SSR'd tool page and extract (name, description).

    prefix_to_strip: literal string to remove from start of title (e.g. 'Future Tools - ').
    suffix_re: regex whose match is stripped from end of title (e.g. r'\\s+AI Reviews.*$').
    Returns None on failure.
    """
    status, body = http(tool_url, timeout=15)
    if status >= 400:
        return None
    try:
        content = body.decode("utf-8", errors="replace")
    except Exception:
        return None

    title_m = re.search(r"<title>([^<]+)</title>", content)
    title = (title_m.group(1) if title_m else "").strip()
    # HTML entity decode for common ones in titles
    title = title.replace("&amp;", "&").replace("&#x27;", "'").replace("&quot;", '"')

    name = title
    if prefix_to_strip and name.startswith(prefix_to_strip):
        name = name[len(prefix_to_strip):]
    if suffix_re:
        name = re.sub(suffix_re, "", name)
    name = name.strip()

    desc_m = re.search(r'<meta\s+name="description"\s+content="([^"]*)"', content)
    desc = (desc_m.group(1) if desc_m else "").strip()
    desc = desc.replace("&amp;", "&").replace("&#x27;", "'").replace("&quot;", '"')

    # Skip if name is clearly garbage
    if not name or len(name) > 200:
        return None

    return {"name": name, "description": desc}


def collect_ai_apps(at_key, today):
    """Discover new AI tools from FutureTools + Futurepedia sitemaps and upsert
    to AI Apps table. Scrape cap per site per run prevents flooding; newest
    URLs (by lastmod) are scraped first so we catch recent additions quickly."""
    # Load existing AI Apps by name (case-insensitive) + URL for dedup
    try:
        existing = at_list_all(
            AIRTABLE_BASE, TABLE_AI_APPS, [F_APP_NAME, F_APP_URL], at_key
        )
    except Exception as e:
        print(f"WARN ai_apps read existing: {e}", file=sys.stderr)
        existing = []
    existing_names = set()
    existing_urls = set()
    for r in existing:
        f = r.get("fields", {}) or {}
        n = (f.get(F_APP_NAME) or "").strip().lower()
        u = (f.get(F_APP_URL) or "").strip().rstrip("/").lower()
        if n:
            existing_names.add(n)
        if u:
            existing_urls.add(u)

    total_created = 0
    total_scraped = 0
    for source_label, sitemap_url, prefix, suffix_re, path_filter in APP_SITEMAPS:
        entries = fetch_sitemap_entries(sitemap_url)
        entries = [e for e in entries if path_filter in e["url"]]
        # Sort by lastmod descending (newest first); empty lastmod sorts last
        entries.sort(key=lambda e: e["lastmod"] or "", reverse=True)
        print(f"{source_label} sitemap: {len(entries)} tool URLs")

        records = []
        scraped = 0
        for entry in entries:
            if scraped >= AI_APPS_MAX_NEW_PER_RUN:
                break
            tool_url = entry["url"].rstrip("/")
            if tool_url.lower() in existing_urls:
                continue

            parsed = parse_tool_page(tool_url, prefix, suffix_re)
            if not parsed:
                continue
            name = parsed["name"]
            name_lc = name.lower()
            if name_lc in existing_names:
                # Name match but URL miss — probably already tracked via manual
                # seed. Skip without counting toward cap. Add URL to memory so
                # we don't hit it again this run.
                existing_urls.add(tool_url.lower())
                continue
            existing_names.add(name_lc)
            existing_urls.add(tool_url.lower())

            records.append({
                F_APP_NAME:        name[:250],
                F_APP_CATEGORY:    "Other",  # human/Claude categorises later
                F_APP_DESCRIPTION: parsed["description"][:1000],
                F_APP_URL:         tool_url,
                F_APP_STATUS:      "Tracking",
                F_APP_DATE_FOUND:  today,
                F_APP_LAST_CHECKED:today,
                F_APP_NOTES:       f"Auto-discovered via {source_label} sitemap on {today}.",
            })
            scraped += 1
            total_scraped += 1
            time.sleep(AI_APPS_SCRAPE_DELAY)

        created = at_create(AIRTABLE_BASE, TABLE_AI_APPS, records, at_key)
        total_created += created
        print(f"{source_label}: {created} new AI Apps created (scraped {scraped})")

    print(f"ai_apps total: {total_created} new (scraped {total_scraped} across "
          f"{len(APP_SITEMAPS)} sources; cap {AI_APPS_MAX_NEW_PER_RUN}/site/run)")


def hf_models_for_task(task, limit=HF_MODELS_PER_TASK):
    """Fetch top N models for a given HuggingFace pipeline_tag.
    Returns raw list from HF API. Empty list on failure."""
    url = (
        f"https://huggingface.co/api/models"
        f"?pipeline_tag={task}"
        f"&sort=downloads&direction=-1&limit={limit}&full=false"
    )
    status, body = http(url)
    if status >= 400:
        print(f"WARN hf models {task}: {status}", file=sys.stderr)
        return []
    try:
        data = json.loads(body)
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"WARN hf models {task} parse: {e}", file=sys.stderr)
        return []


def collect_hf_models(at_key, today):
    """Pull top HuggingFace models across core pipeline tasks and upsert to
    AI Models table. Only updates technical fields (downloads/likes go into
    Notes). Leaves curated fields (Quality Tier, Currently In Use For) alone."""
    try:
        existing = at_list_all(AIRTABLE_BASE, TABLE_AI_MODELS,
                               [F_AM_SLUG], at_key)
    except Exception as e:
        print(f"WARN hf models read existing: {e}", file=sys.stderr)
        existing = []
    by_slug = {}
    for r in existing:
        f = r.get("fields", {}) or {}
        slug = (f.get(F_AM_SLUG) or "").strip().lower()
        if slug:
            by_slug[slug] = r["id"]

    updates, creates = [], []
    seen_this_run = set()
    total_fetched = 0

    for task in HF_PIPELINE_TAGS:
        models = hf_models_for_task(task)
        total_fetched += len(models)
        good_for = HF_TAG_TO_GOOD_FOR.get(task, [])

        for m in models:
            slug = (m.get("id") or m.get("modelId") or "").strip()
            if not slug or slug.lower() in seen_this_run:
                continue
            seen_this_run.add(slug.lower())
            author = m.get("author") or (slug.split("/")[0] if "/" in slug else "")
            downloads = m.get("downloads", 0) or 0
            likes = m.get("likes", 0) or 0
            is_gated = bool(m.get("gated"))
            note_parts = [
                f"HF task: {task}",
                f"downloads: {downloads:,}",
                f"likes: {likes}",
            ]
            if is_gated:
                note_parts.append("GATED (requires HF auth + license acceptance)")

            fields = {
                F_AM_NAME:         slug[:250],
                F_AM_SLUG:         slug,
                F_AM_PROVIDER:     author,
                F_AM_VIA:          "HuggingFace",
                F_AM_TIER:         "Free",
                F_AM_INPUT_PRICE:  0,
                F_AM_OUTPUT_PRICE: 0,
                F_AM_LAST_CHECKED: today,
                F_AM_NOTES:        " | ".join(note_parts),
            }

            existing_id = by_slug.get(slug.lower())
            if existing_id:
                updates.append({"id": existing_id, "fields": fields})
            else:
                fields[F_AM_FIRST_FOUND] = today
                fields[F_AM_STATUS] = "Active"
                if good_for:
                    fields[F_AM_GOOD_FOR] = good_for
                creates.append(fields)

    created = at_create(AIRTABLE_BASE, TABLE_AI_MODELS, creates, at_key)
    updated = at_update(AIRTABLE_BASE, TABLE_AI_MODELS, updates, at_key)
    print(
        f"hf_models: {created} new, {updated} refreshed "
        f"(fetched {total_fetched} across {len(HF_PIPELINE_TAGS)} HF tasks)"
    )


def collect_ai_models(at_key, today):
    """Refresh AI Models table from OpenRouter's model catalog.

    Only updates technical fields (pricing, context, status) — leaves human-
    curated fields (Good For, Quality Tier, Currently In Use For, Notes)
    untouched on existing rows. Filters to known-interesting providers so
    the table stays focused (~40-60 rows, not 300+).
    """
    status, body = http("https://openrouter.ai/api/v1/models")
    if status >= 400:
        print(f"WARN openrouter models: {status}", file=sys.stderr)
        return
    try:
        data = json.loads(body)
    except Exception as e:
        print(f"WARN openrouter models parse: {e}", file=sys.stderr)
        return
    models = data.get("data", [])
    if not models:
        print("WARN openrouter models: empty list", file=sys.stderr)
        return

    # Load existing rows indexed by Slug
    try:
        existing = at_list_all(AIRTABLE_BASE, TABLE_AI_MODELS,
                               [F_AM_SLUG], at_key)
    except Exception as e:
        print(f"WARN openrouter models read existing: {e}", file=sys.stderr)
        existing = []
    by_slug = {}
    for r in existing:
        f = r.get("fields", {}) or {}
        slug = (f.get(F_AM_SLUG) or "").strip().lower()
        if slug:
            by_slug[slug] = r["id"]

    updates, creates = [], []
    skipped_providers = 0
    for m in models:
        slug = (m.get("id") or "").strip()
        if not slug:
            continue
        provider = slug.split("/")[0].lower() if "/" in slug else ""
        if provider not in INTERESTING_MODEL_PROVIDERS:
            skipped_providers += 1
            continue
        name = m.get("name") or slug
        pricing = m.get("pricing") or {}
        try:
            input_price = float(pricing.get("prompt") or 0) * 1_000_000
            output_price = float(pricing.get("completion") or 0) * 1_000_000
        except (ValueError, TypeError):
            input_price, output_price = 0, 0
        context = m.get("context_length") or 0
        is_free = slug.endswith(":free") or (input_price == 0 and output_price == 0)

        fields = {
            F_AM_NAME:         name[:250],
            F_AM_SLUG:         slug,
            F_AM_PROVIDER:     provider,
            F_AM_VIA:          "OpenRouter",
            F_AM_TIER:         "Free" if is_free else "Paid",
            F_AM_INPUT_PRICE:  round(input_price, 4),
            F_AM_OUTPUT_PRICE: round(output_price, 4),
            F_AM_CONTEXT:      int(context) if context else 0,
            F_AM_LAST_CHECKED: today,
        }

        existing_id = by_slug.get(slug.lower())
        if existing_id:
            updates.append({"id": existing_id, "fields": fields})
        else:
            fields[F_AM_FIRST_FOUND] = today
            fields[F_AM_STATUS] = "Active"
            creates.append(fields)

    created = at_create(AIRTABLE_BASE, TABLE_AI_MODELS, creates, at_key)
    updated = at_update(AIRTABLE_BASE, TABLE_AI_MODELS, updates, at_key)
    print(
        f"ai_models: {created} new, {updated} refreshed "
        f"(of {len(models)} total; {skipped_providers} skipped as non-core providers)"
    )


def collect_hf_trending(at_key, today, openrouter_keys=None, classifier_model=None):
    """Pull HF trending models into Intel Feed as Feed Type='AI News'."""
    # Dedup against Intel Feed (replaces old TABLE_NEWS)
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_INTEL_FEED, F_IF_TITLE, at_key)
    records = []
    for it in hf_trending_models():
        title = it["title"][:250]
        if title.strip().lower() in seen:
            continue
        seen.add(title.strip().lower())
        fields = {
            F_IF_TITLE:      title,
            F_IF_FEED_TYPE:  "AI News",
            F_IF_SOURCE:     "HuggingFace Trending",
            F_IF_SOURCE_URL: it["link"],
            F_IF_DATE_FOUND: today,
            F_IF_SUMMARY:    it.get("summary", ""),
            F_IF_DECISION:   "Pending",
        }
        d = parse_date(it.get("date"))
        if d:
            fields[F_IF_DATE_PUB] = d
        records.append(fields)

    source_items = [{"title": r[F_IF_TITLE], "summary": r.get(F_IF_SUMMARY, "")} for r in records]
    decisions = pre_classify(source_items, openrouter_keys, classifier_model, at_key=at_key)
    skipped = apply_pre_classification(
        records, source_items, decisions,
        F_IF_DECISION, "Dismiss", F_IF_NOTES,
    )
    print(f"hf_trending pre-classify: auto-Dismissed {skipped} irrelevant items")
    created = at_create(AIRTABLE_BASE, TABLE_INTEL_FEED, records, at_key)
    print(f"hf_trending: {created} created (of {len(records)} candidates)")


# ---------- Gemini evaluation ----------

def get_gemini_key_from_airtable(at_key):
    """Fetch Gemini API key from the 'Google Gemini' row in Logins & Keys.
    Falls back to GEMINI_API_KEY env var. Returns None if nothing found.
    Never logs the key value.
    """
    try:
        rows = at_list_all(AIRTABLE_BASE, TABLE_LOGINS_KEYS,
                           [F_LK_NAME, F_LK_KEYS], at_key)
    except Exception as e:
        print(f"WARN gemini key lookup: {e}", file=sys.stderr)
        rows = []
    for r in rows:
        f = r.get("fields", {}) or {}
        name = (f.get(F_LK_NAME) or "").strip().lower().replace(" ", "")
        if "gemini" in name:
            for line in (f.get(F_LK_KEYS) or "").splitlines():
                line = line.strip()
                if line.startswith("AIzaSy"):
                    print(f"gemini key: loaded from Airtable (suffix=...{line[-4:]})")
                    return line
    env_val = (os.environ.get("GEMINI_API_KEY") or "").strip()
    if env_val:
        print(f"gemini key: loaded from env (suffix=...{env_val[-4:]})")
        return env_val
    print("WARN gemini: no API key found in Airtable or env — evaluation pass skipped",
          file=sys.stderr)
    return None


def gemini_evaluate(items, api_key, prompt_fn, batch_size=GEMINI_EVAL_BATCH_SIZE):
    """Batch-evaluate items via Gemini API. Returns a list of result dicts
    (one per item, in input order). Items that fail evaluation return None.

    prompt_fn(batch) → prompt string. Each batch item has 'id', 'title', 'summary'.
    Uses responseMimeType=application/json to get clean JSON output.
    Retries once on 429; sleeps GEMINI_SLEEP seconds between batches.
    """
    if not items or not api_key:
        return [None] * len(items)

    results = [None] * len(items)
    for start in range(0, len(items), batch_size):
        batch = items[start: start + batch_size]
        prompt = prompt_fn(batch)

        body = json.dumps({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": 0,
                "maxOutputTokens": 4096,
                "responseMimeType": "application/json",
            },
        }).encode()
        headers = {"Content-Type": "application/json"}
        url = f"{GEMINI_URL}?key={api_key}"

        status, resp_body = http(url, method="POST", headers=headers, body=body)
        if status == 429:
            print(f"WARN gemini rate-limit at batch {start} — sleeping 60s", file=sys.stderr)
            time.sleep(60)
            status, resp_body = http(url, method="POST", headers=headers, body=body)

        if status >= 400:
            print(f"WARN gemini batch {start}: HTTP {status} {resp_body[:200]!r}",
                  file=sys.stderr)
            time.sleep(GEMINI_SLEEP)
            continue  # leave results[start:...] as None

        try:
            resp = json.loads(resp_body)
            text = (resp.get("candidates", [{}])[0]
                       .get("content", {})
                       .get("parts", [{}])[0]
                       .get("text", "")).strip()
            # Strip markdown fences if model ignored responseMimeType
            if text.startswith("```"):
                parts = text.split("```")
                if len(parts) >= 2:
                    text = parts[1]
                    if text.lower().startswith("json\n"):
                        text = text[5:]
            parsed = json.loads(text)
            if isinstance(parsed, list) and len(parsed) == len(batch):
                for i, r in enumerate(parsed):
                    results[start + i] = r if isinstance(r, dict) else None
            else:
                print(f"WARN gemini batch {start}: expected list of {len(batch)}, "
                      f"got {type(parsed).__name__} len={len(parsed) if isinstance(parsed, list) else '?'}",
                      file=sys.stderr)
        except Exception as e:
            print(f"WARN gemini batch {start} parse: {e}", file=sys.stderr)

        time.sleep(GEMINI_SLEEP)

    return results


def evaluate_pending_skills(at_key, gemini_key, today):
    """Use Gemini to pre-fill Type, Relevance to Us, Effort to Adopt, and Audit Notes
    on Skills rows where Type='Discovered' and Last Audited is blank.

    After this runs, the Mon/Thu intel-brief Step 2 becomes a review-and-Task-create
    pass rather than a full evaluation — Claude only acts on Gemini's Recommended picks.
    Returns count of records updated.
    """
    rows = at_list_all(
        AIRTABLE_BASE, TABLE_SKILLS,
        [F_S_NAME, F_S_TYPE, F_S_DESC, F_S_SOURCE_URL,
         "fldR60TGsI3N3fxjG"],   # Last Audited
        at_key,
    )

    pending = []
    for r in rows:
        f = r.get("fields", {}) or {}
        if ((f.get(F_S_TYPE) or "").strip() == "Discovered"
                and not f.get("fldR60TGsI3N3fxjG")):
            pending.append({
                "id":      r["id"],
                "title":   (f.get(F_S_NAME) or "")[:200],
                "summary": (f.get(F_S_DESC) or "")[:400],
            })

    if not pending:
        print("evaluate_pending_skills: 0 Discovered skills need evaluation")
        return 0

    print(f"evaluate_pending_skills: evaluating {len(pending)} skills via Gemini")

    def make_prompt(batch):
        return (
            f"You are evaluating GitHub skills/plugins for HypeBase.\n\n"
            f"CONTEXT: {HYPEBASE_CONTEXT_FOR_CLASSIFIER}\n\n"
            f"For each skill, return a JSON array (same length, same order). Each element:\n"
            f'{{\n'
            f'  "id": "<same id from input>",\n'
            f'  "type": "Recommended" | "Discovered" | "Rejected",\n'
            f'  "relevance": "<1-2 sentences: why it helps HypeBase, or why it doesn\'t>",\n'
            f'  "effort": "S" | "M" | "L",\n'
            f'  "audit_notes": "<concise: where in our pipeline it fits, or rejection reason>"\n'
            f"}}\n\n"
            f"Guidelines:\n"
            f'- "Recommended": direct, clear value for HypeBase right now\n'
            f'- "Discovered": might be useful but unclear fit — leave for human review\n'
            f'- "Rejected": no relevance\n'
            f"- Effort: S=hours, M=days, L=week+\n\n"
            f"INPUT: {json.dumps([{'id': it['id'], 'title': it['title'], 'desc': it['summary']} for it in batch])}\n\n"
            f"Return ONLY the JSON array."
        )

    results = gemini_evaluate(pending, gemini_key, make_prompt)

    updates = []
    for item, result in zip(pending, results):
        if not result:
            continue
        fields = {
            "fldR60TGsI3N3fxjG": today,          # Last Audited
            "fldRBvfKj9aX80tuP": "Gemini pre-eval",  # Audit Status
        }
        skill_type = (result.get("type") or "").strip()
        if skill_type in ("Recommended", "Rejected"):
            fields[F_S_TYPE] = skill_type
        relevance = (result.get("relevance") or "").strip()[:1000]
        if relevance:
            fields["fldpHZvluU0FZQpln"] = relevance   # Relevance to Us
        effort = (result.get("effort") or "").strip()
        if effort in ("S", "M", "L"):
            fields["fldnxq8CkjFALhEh7"] = effort      # Effort to Adopt
        notes = (result.get("audit_notes") or "").strip()[:1000]
        if notes:
            fields[F_S_AUDIT_NOTES] = f"[Gemini] {notes}"
        updates.append({"id": item["id"], "fields": fields})

    done = at_update(AIRTABLE_BASE, TABLE_SKILLS, updates, at_key)
    rec_count = len(results) - results.count(None)
    print(f"evaluate_pending_skills: updated {done} of {rec_count} successfully evaluated")
    return done


def evaluate_pending_intel_feed(at_key, gemini_key, today,
                                feed_types=None):
    """Use Gemini to pre-fill Why It Matters, Use Cases, Effort, Relevance, and Decision
    on Pending Intel Feed rows for the given Feed Types.

    Defaults to Platform Update + AI News. Deals are excluded by default because
    they need a manual cost comparison before a decision is meaningful.

    After this runs, the intel-brief Steps 3 and 4 become review-and-Task-create
    passes — Claude reads pre-filled fields rather than evaluating from scratch.
    Returns total count of records updated across all feed types.
    """
    if feed_types is None:
        feed_types = ["Platform Update", "AI News"]

    rows = at_list_all(
        AIRTABLE_BASE, TABLE_INTEL_FEED,
        [F_IF_TITLE, F_IF_FEED_TYPE, F_IF_SUMMARY, F_IF_DECISION, F_IF_SOURCE],
        at_key,
    )

    # Valid Decision values vary by Feed Type
    decision_options = {
        "Platform Update": ["Adopt Now", "Prototype", "Watch", "Ignore"],
        "AI News":         ["Act On", "Explore", "Reference", "Dismiss"],
        "Deal":            ["Buy", "Trial", "Watch", "Skip"],
    }

    # Group Pending rows by feed type
    by_type: dict = {ft: [] for ft in feed_types}
    for r in rows:
        f = r.get("fields", {}) or {}
        ft = (f.get(F_IF_FEED_TYPE) or "").strip()
        decision = (f.get(F_IF_DECISION) or "").strip()
        if ft in by_type and decision in ("Pending", ""):
            by_type[ft].append({
                "id":      r["id"],
                "title":   (f.get(F_IF_TITLE) or "")[:200],
                "summary": (f.get(F_IF_SUMMARY) or "")[:400],
                "source":  (f.get(F_IF_SOURCE) or ""),
            })

    total_updated = 0
    for feed_type, items in by_type.items():
        if not items:
            print(f"evaluate_pending_intel_feed [{feed_type}]: 0 Pending items")
            continue

        print(f"evaluate_pending_intel_feed [{feed_type}]: "
              f"evaluating {len(items)} items via Gemini")
        valid_decisions = decision_options.get(feed_type, ["Watch", "Ignore"])

        def make_prompt(batch, ft=feed_type, vd=valid_decisions):
            return (
                f"You are pre-evaluating {ft} items for a HypeBase intelligence brief.\n\n"
                f"CONTEXT: {HYPEBASE_CONTEXT_FOR_CLASSIFIER}\n\n"
                f"For each item, return a JSON array (same length, same order). Each element:\n"
                f'{{\n'
                f'  "id": "<same id from input>",\n'
                f'  "decision": "{" | ".join(vd)}",\n'
                f'  "why_it_matters": "<1-2 sentences specific to HypeBase, or why it doesn\'t>",\n'
                f'  "use_case_1": "<concrete HypeBase use case, or empty string>",\n'
                f'  "use_case_2": "<second use case if applicable, else empty string>",\n'
                f'  "effort": "S" | "M" | "L",\n'
                f'  "relevance": "High" | "Medium" | "Low"\n'
                f"}}\n\n"
                f"Be conservative — only top-tier decisions for clear wins. "
                f"Err toward lower decisions when uncertain.\n\n"
                f"INPUT: {json.dumps([{{'id': it['id'], 'title': it['title'], 'summary': it['summary']}} for it in batch])}\n\n"
                f"Return ONLY the JSON array."
            )

        results = gemini_evaluate(items, gemini_key, make_prompt)

        updates = []
        valid_set = set(valid_decisions)
        for item, result in zip(items, results):
            if not result:
                continue
            fields = {}
            decision = (result.get("decision") or "").strip()
            if decision in valid_set:
                fields[F_IF_DECISION] = decision
            why = (result.get("why_it_matters") or "").strip()[:1000]
            if why:
                fields[F_IF_WHY] = why
            uc1 = (result.get("use_case_1") or "").strip()[:500]
            if uc1:
                fields[F_IF_USE_CASE_1] = uc1
            uc2 = (result.get("use_case_2") or "").strip()[:500]
            if uc2:
                fields[F_IF_USE_CASE_2] = uc2
            effort = (result.get("effort") or "").strip()
            if effort in ("S", "M", "L"):
                fields[F_IF_EFFORT] = effort
            rel = (result.get("relevance") or "").strip()
            if rel in ("High", "Medium", "Low"):
                fields[F_IF_RELEVANCE] = rel
            if fields:
                updates.append({"id": item["id"], "fields": fields})

        done = at_update(AIRTABLE_BASE, TABLE_INTEL_FEED, updates, at_key)
        print(f"evaluate_pending_intel_feed [{feed_type}]: updated {done} records")
        total_updated += done

    return total_updated


# ---------- Main ----------

def main():
    at_key = os.environ["AIRTABLE_API_KEY"]
    gh_token = os.environ["TRIAGE_GH_TOKEN"]
    today = datetime.now(timezone.utc).date().isoformat()
    print(f"intel-collector run: {today}")
    print(f"DEBUG: AIRTABLE_API_KEY len={len(at_key)} suffix=...{at_key[-4:]}")
    print(f"DEBUG: TRIAGE_GH_TOKEN  len={len(gh_token)} suffix=...{gh_token[-4:]}")

    openrouter_keys  = get_openrouter_keys_from_airtable(at_key)
    classifier_model = get_classifier_model_from_airtable(at_key)
    gemini_key       = get_gemini_key_from_airtable(at_key)

    # --- Collection pass (Qwen pre-classifier filters noise at write time) ---
    collect_platform_updates(at_key, gh_token, today, openrouter_keys, classifier_model)
    collect_ai_news(at_key, today, openrouter_keys, classifier_model)
    collect_hf_trending(at_key, today, openrouter_keys, classifier_model)
    collect_deals(at_key, today, openrouter_keys, classifier_model)
    collect_skills(at_key, gh_token, today, openrouter_keys, classifier_model)
    dismiss_irrelevant_pending_apis(at_key)   # no-op on new table; safe to call
    collect_apis(at_key, today, openrouter_keys, classifier_model)

    # --- Gemini evaluation pass (pre-fills fields so intel-brief is review-only) ---
    if gemini_key:
        evaluate_pending_skills(at_key, gemini_key, today)
        evaluate_pending_intel_feed(at_key, gemini_key, today,
                                    feed_types=["Platform Update", "AI News"])
    else:
        print("gemini evaluation: skipped (no key)")

    # Refresh AI Models catalog — wrapped in try/except while field IDs are being resolved
    # (TABLE_AI_MODELS was renamed April 2026; field schema pending audit).
    try:
        collect_ai_models(at_key, today)
    except Exception as e:
        print(f"WARN collect_ai_models skipped: {e}", file=sys.stderr)
    try:
        collect_hf_models(at_key, today)
    except Exception as e:
        print(f"WARN collect_hf_models skipped: {e}", file=sys.stderr)
    # Discover new AI Apps from FutureTools + Futurepedia sitemaps.
    try:
        collect_ai_apps(at_key, today)
    except Exception as e:
        print(f"WARN collect_ai_apps skipped: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
