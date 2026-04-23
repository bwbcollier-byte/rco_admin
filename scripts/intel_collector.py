#!/usr/bin/env python3
"""
Intel collector — runs daily via GitHub Actions.

Pulls from free RSS / GitHub / HN sources and upserts new items into Airtable
tables (Platform Updates, AI News, Deals, Skills) with Decision=Pending.
The Monday/Thursday strategic-intel-brief Claude routine reviews the Pending
items, adds HypeBase-specific reasoning, and sets real Decision values.

Stdlib only. No third-party deps.

Env vars required:
  TRIAGE_GH_TOKEN    PAT with public_repo or repo (read) scope
  AIRTABLE_API_KEY   PAT with data.records:read/write on base app6biS7yjV6XzFVG
"""
import email.utils as eu
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib import request, error
from urllib.parse import quote

# ---------- Airtable layout ----------

AIRTABLE_BASE = "app6biS7yjV6XzFVG"

TABLE_PLATFORM = "tblW6XV9X5gBrghOv"
TABLE_NEWS     = "tbl4IUWP09vzchU5t"
TABLE_DEALS    = "tbl9a3WVIhW7NddYz"
TABLE_SKILLS   = "tblRYHxXNItKHXqg7"

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

# ---------- Source config ----------

PLATFORM_SOURCES = [
    # Tier 1 — we actively use these
    {"name": "GitHub",                "tier": "Tier 1 - Active Use", "kind": "rss",
     "url":  "https://github.blog/changelog/feed/"},
    {"name": "Supabase",              "tier": "Tier 1 - Active Use", "kind": "releases",
     "repo": "supabase/supabase"},
    {"name": "Anthropic Claude Code", "tier": "Tier 1 - Active Use", "kind": "releases",
     "repo": "anthropics/claude-code"},
    {"name": "Anthropic SDK Python",  "tier": "Tier 1 - Active Use", "kind": "releases",
     "repo": "anthropics/anthropic-sdk-python"},
    # Tier 3 — we track for opportunity
    {"name": "Vercel AI SDK",         "tier": "Tier 3 - Tracking", "kind": "releases",
     "repo": "vercel/ai"},
    {"name": "OpenAI Python SDK",     "tier": "Tier 3 - Tracking", "kind": "releases",
     "repo": "openai/openai-python"},
    {"name": "LangChain",             "tier": "Tier 3 - Tracking", "kind": "releases",
     "repo": "langchain-ai/langchain"},
    {"name": "Cloudflare",            "tier": "Tier 3 - Tracking", "kind": "rss",
     "url":  "https://blog.cloudflare.com/rss/"},
]

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

SKILL_TOPICS = ["claude-code-skills", "claude-skills", "anthropic-skills"]

LOOKBACK_DAYS  = 3   # platform updates + news: last N days
SKILL_LOOKBACK = 21  # skill repos: last N days of pushes
HN_TOP_LIMIT   = 200 # number of top stories to scan
SUMMARY_CAP    = 1800
SLEEP_BETWEEN_WRITES = 0.3  # gentle on Airtable's 5-rps base limit

# ---------- HTTP ----------

def http(url, method="GET", headers=None, body=None, timeout=30):
    headers = dict(headers or {})
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
    """Best-effort RSS 2.0 + Atom parser. Returns list of {title, link, summary, date}."""
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
    """Return YYYY-MM-DD string or None."""
    if not s:
        return None
    try:
        if "T" in s:
            return s[:10]
        dt = eu.parsedate_to_datetime(s)
        return dt.strftime("%Y-%m-%d") if dt else None
    except Exception:
        return None


# ---------- Source fetchers ----------

def gh_releases(repo, token, days=LOOKBACK_DAYS):
    url = f"https://api.github.com/repos/{repo}/releases?per_page=10"
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "User-Agent": "intel-collector"}
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
            "title": r.get("name") or r.get("tag_name") or "(unnamed release)",
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
               "Accept": "application/vnd.github+json",
               "User-Agent": "intel-collector"}
    status, body = http(url, headers=headers)
    if status >= 400:
        print(f"WARN gh_topic_search {topic}: {status} {body[:200]!r}", file=sys.stderr)
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


# ---------- Airtable ----------

def at_list_all(base, table, field_ids, key_token):
    headers = {"Authorization": f"Bearer {key_token}", "User-Agent": "intel-collector"}
    all_rows = []
    offset = None
    while True:
        qs = "pageSize=100" + ("&offset=" + offset if offset else "")
        if field_ids:
            qs += "&" + "&".join(f"fields[]={f}" for f in field_ids)
        url = f"https://api.airtable.com/v0/{base}/{table}?{qs}"
        status, body = http(url, headers=headers)
        if status >= 400:
            print(f"WARN airtable list {table}: {status} {body[:300]!r}", file=sys.stderr)
            break
        data = json.loads(body)
        all_rows.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
        time.sleep(SLEEP_BETWEEN_WRITES)
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
               "Content-Type": "application/json",
               "User-Agent": "intel-collector"}
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
        time.sleep(SLEEP_BETWEEN_WRITES)
    return created


# ---------- Collectors ----------

def collect_platform_updates(at_key, gh_token, today):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_PLATFORM, F_P_TITLE, at_key)
    records = []
    for src in PLATFORM_SOURCES:
        if src["kind"] == "rss":
            status, body = http(src["url"])
            items = parse_feed(body) if status < 400 else []
            if status >= 400:
                print(f"WARN rss {src['name']}: {status}", file=sys.stderr)
        else:  # releases
            items = gh_releases(src["repo"], gh_token)
        for it in items:
            title = f"[{src['name']}] {it['title']}"[:250]
            if title.strip().lower() in seen:
                continue
            seen.add(title.strip().lower())
            fields = {
                F_P_TITLE:      title,
                F_P_PLATFORM:   src["name"],
                F_P_TIER:       src["tier"],
                F_P_DATE_FOUND: today,
                F_P_SUMMARY:    it.get("summary", ""),
                F_P_SOURCE_URL: it.get("link", ""),
                F_P_DECISION:   "Pending",
            }
            d = parse_date(it.get("date"))
            if d:
                fields[F_P_DATE_SHIP] = d
            records.append(fields)
    print(f"platform: {at_create(AIRTABLE_BASE, TABLE_PLATFORM, records, at_key)} created "
          f"(of {len(records)} new candidates; {len(seen)} total now tracked)")


def collect_ai_news(at_key, today):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_NEWS, F_N_HEADLINE, at_key)
    records = []
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
    print(f"ai_news: {at_create(AIRTABLE_BASE, TABLE_NEWS, records, at_key)} created "
          f"(of {len(records)} new candidates)")


def collect_deals(at_key, today):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_DEALS, F_D_NAME, at_key)
    records = []
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
    else:
        print(f"WARN producthunt rss: {status}", file=sys.stderr)
    print(f"deals: {at_create(AIRTABLE_BASE, TABLE_DEALS, records, at_key)} created "
          f"(of {len(records)} new candidates)")


def collect_skills(at_key, gh_token, today):
    seen = at_existing_titles(AIRTABLE_BASE, TABLE_SKILLS, F_S_NAME, at_key)
    records = []
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
    print(f"skills: {at_create(AIRTABLE_BASE, TABLE_SKILLS, records, at_key)} created "
          f"(of {len(records)} new candidates)")


def main():
    at_key = os.environ["AIRTABLE_API_KEY"]
    gh_token = os.environ["TRIAGE_GH_TOKEN"]
    today = datetime.now(timezone.utc).date().isoformat()
    print(f"intel-collector run: {today}")
    print(f"DEBUG: AIRTABLE_API_KEY len={len(at_key)} suffix=...{at_key[-4:]}")
    print(f"DEBUG: TRIAGE_GH_TOKEN  len={len(gh_token)} suffix=...{gh_token[-4:]}")

    collect_platform_updates(at_key, gh_token, today)
    collect_ai_news(at_key, today)
    collect_deals(at_key, today)
    collect_skills(at_key, gh_token, today)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
