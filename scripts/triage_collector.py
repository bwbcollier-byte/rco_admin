#!/usr/bin/env python3
"""
Triage collector — runs hourly via GitHub Actions.
Pulls workflow run data + Actions enablement state, classifies runs,
and upserts into Supabase tables triage_workflow_runs + triage_repo_state.

Env vars required:
  TRIAGE_GH_TOKEN      PAT with repo + read:org scopes
  TRIAGE_SUPABASE_URL  https://<project-ref>.supabase.co
  TRIAGE_SUPABASE_KEY  service role key
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib import request, error
from urllib.parse import urlencode

ORG = "bwbcollier-byte"

# Workflow catalog — keep in sync with ~/.claude/triage-config.json.
# (repo, workflow_file, timeout_minutes)
WORKFLOWS = [
    ("yl-hb-imdb",   "imdb-enrichment.yml",               60),
    ("yl-hb-imdb",   "imdb-news-scraper.yml",             120),
    ("yl-hb-imdb",   "imdb-top-news.yml",                 30),
    ("yl-hb-am",     "allmusic-blog-news-scraper.yml",    30),
    ("yl-hb-am",     "allmusic-news-scraper.yml",         120),
    ("yl-hb-sp",     "spotify-unified-enrichment.yml",    60),
    ("yl-hb-rgm",    "realgm-baseball-news-scraper.yml",  360),
    ("yl-hb-rgm",    "realgm-hockey-news-scraper.yml",    360),
    ("yl-hb-rgm",    "realgm-news-scraper.yml",           360),
    ("yl-hb-rgm",    "realgm-nfl-news-scraper.yml",       360),
    ("yl-hb-rgm",    "realgm-player-scraper.yml",         360),
    ("yl-hb-rgm",    "realgm-soccer-news-scraper.yml",    360),
    ("yl-hb-imdbp",  "discover-games-boxoffice.yml",      360),
    ("yl-hb-imdbp",  "discover-games-moviemeter.yml",     360),
    ("yl-hb-imdbp",  "discover-movies-boxoffice.yml",     360),
    ("yl-hb-imdbp",  "discover-movies-moviemeter.yml",    360),
    ("yl-hb-imdbp",  "discover-tv-boxoffice.yml",         360),
    ("yl-hb-imdbp",  "discover-tv-moviemeter.yml",        360),
    ("yl-hb-imdbp",  "imdb-top-news.yml",                 30),
    ("yl-hb-imdbp",  "imdbpro-company-clients.yml",       300),
    ("yl-hb-imdbp",  "imdbpro-company-enrichment.yml",    360),
    ("yl-hb-imdbp",  "imdbpro-company-staff.yml",         180),
    ("yl-hb-imdbp",  "imdbpro-crm-enrichment.yml",        360),
    ("yl-hb-imdbp",  "imdbpro-discover.yml",              360),
    ("yl-hb-imdbp",  "imdbpro-starmeter.yml",             300),
    ("yl-hb-imdbp",  "imdbpro-worker.yml",                300),
    ("yl-hb-imdbp",  "tmdb-media-enrichment.yml",         360),
    ("yl-hb-tmdb",   "sync-dashboard.yml",                360),
    ("yl-hb-tmdb",   "tmdb-media-enrichment.yml",         60),
    ("yl-hb-tmdb",   "tmdb-movie-now-playing-mining.yml", 30),
    ("yl-hb-tmdb",   "tmdb-movie-popular-mining.yml",     30),
    ("yl-hb-tmdb",   "tmdb-movie-top-rated-mining.yml",   30),
    ("yl-hb-tmdb",   "tmdb-movie-trending-mining.yml",    30),
    ("yl-hb-tmdb",   "tmdb-movie-upcoming-mining.yml",    30),
    ("yl-hb-tmdb",   "tmdb-popular-mining.yml",           60),
    ("yl-hb-tmdb",   "tmdb-social-enrichment.yml",        60),
    ("yl-hb-tmdb",   "tmdb-trending-mining.yml",          30),
    ("yl-hb-tmdb",   "tmdb-tv-airing-today-mining.yml",   30),
    ("yl-hb-tmdb",   "tmdb-tv-on-the-air-mining.yml",     30),
    ("yl-hb-tmdb",   "tmdb-tv-popular-mining.yml",        30),
    ("yl-hb-tmdb",   "tmdb-tv-top-rated-mining.yml",      30),
    ("yl-hb-tm",     "tm-enrichment.yml",                 120),
    ("yl-hb-ml",     "musiclinks-enrichment.yml",         360),
    ("yl-hb-ml",     "ml-media-enrichment.yml",           360),
    ("yl-hb-ml",     "ml-social-enrichment.yml",          360),
    ("yl-hb-tadb",   "enrich-tadb.yml",                   480),
    ("yl-hb-dtp",    "nightly-cleanup.yml",               360),
    ("yl-hb-sc",     "enrich.yml",                        360),
    ("yl-hb-ig",     "enrich_instagram.yml",              360),
    ("yl-hb-bit",    "enrich_bandsintown.yml",            360),
    ("yl-hb-dz",     "deezer-airtable-sync.yml",          360),
    ("yl-hb-dz",     "deezer-unified-enrichment.yml",     350),
    ("yl-hb-sk",     "enrich_songkick.yml",               360),
    ("yl-hb-tw",     "twitter-enrichment.yml",            360),
    ("-yl-hb-rm",    "enrich_rovi.yml",                   360),
]

REPOS = sorted(set(repo for repo, _, _ in WORKFLOWS))

EARLY_FINISH_PCT = 0.50
HEALTHY_MIN_PCT = 0.80
LOG_PREVIEW_BYTES = 4096
LOOKBACK_HOURS = 48


def _req(url, method="GET", headers=None, body=None, timeout=30):
    headers = headers or {}
    if body is not None and not isinstance(body, bytes):
        body = json.dumps(body).encode()
        headers.setdefault("Content-Type", "application/json")
    req = request.Request(url, method=method, headers=headers, data=body)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except error.HTTPError as e:
        return e.code, e.read()


def gh_api(path, token, params=None):
    url = f"https://api.github.com{path}"
    if params:
        url += "?" + urlencode(params)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "triage-collector",
    }
    status, body = _req(url, headers=headers)
    if status >= 400:
        raise RuntimeError(f"GH {status} {path}: {body[:200]!r}")
    return json.loads(body)


def gh_logs_tail(repo, run_id, token, n_bytes=LOG_PREVIEW_BYTES):
    url = f"https://api.github.com/repos/{ORG}/{repo}/actions/runs/{run_id}/logs"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3.raw",
        "User-Agent": "triage-collector",
    }
    status, body = _req(url, headers=headers, timeout=30)
    if status >= 400:
        return None
    return body[-n_bytes:].decode("utf-8", errors="replace")


def sb_upsert(table, rows, on_conflict, url, key):
    if not rows:
        return
    api = f"{url}/rest/v1/{table}?on_conflict={on_conflict}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Prefer": "resolution=merge-duplicates,return=minimal",
        "Content-Type": "application/json",
    }
    status, body = _req(api, method="POST", headers=headers, body=rows)
    if status >= 400:
        raise RuntimeError(f"Supabase {status} upserting {table}: {body[:300]!r}")


TIMEOUT_MARKERS = ["exceeded the maximum execution time"]


def classify(conclusion, duration_min, timeout_min, log_text):
    if conclusion is None:
        return "in-progress"
    if conclusion == "success":
        if duration_min is None or not timeout_min:
            return "healthy"
        return "early-finish" if duration_min / timeout_min < EARLY_FINISH_PCT else "healthy"
    if conclusion == "timed_out":
        return "hard-timeout"
    if conclusion == "failure" and log_text and any(m in log_text for m in TIMEOUT_MARKERS):
        return "hard-timeout"
    if conclusion in ("failure", "cancelled"):
        return "failed"
    return "failed"


def error_fingerprint(log_text):
    if not log_text:
        return "no-log"
    for line in log_text.splitlines():
        if "##[error]" in line or "Error:" in line or "Traceback" in line:
            msg = line.split("##[error]", 1)[-1].strip()
            msg = re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\S*", "", msg)
            msg = re.sub(r"\d+", "N", msg)
            msg = re.sub(r"/[\w/.\-]+", "/PATH", msg)
            return msg[:200] or "empty-error"
    return "no-error-line"


def signature(repo, workflow_file, classification, fp):
    key = f"{repo}:{workflow_file}:{classification}:{fp}"
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def collect():
    gh_token = os.environ["TRIAGE_GH_TOKEN"]
    sb_url = os.environ["TRIAGE_SUPABASE_URL"].rstrip("/")
    sb_key = os.environ["TRIAGE_SUPABASE_KEY"]

    timeouts = {(r, f): t for r, f, t in WORKFLOWS}
    now = datetime.now(timezone.utc)

    # 1. Repo permissions
    repo_rows = []
    for repo in REPOS:
        try:
            perms = gh_api(f"/repos/{ORG}/{repo}/actions/permissions", gh_token)
            enabled = bool(perms.get("enabled"))
        except Exception as e:
            print(f"WARN permissions {repo}: {e}", file=sys.stderr)
            enabled = None
        repo_rows.append({
            "repo": repo,
            "actions_enabled": enabled,
            "checked_at": now.isoformat(),
        })
    sb_upsert("triage_repo_state", repo_rows, "repo", sb_url, sb_key)
    print(f"repo_state: {len(repo_rows)} rows")

    # 2. Runs in last LOOKBACK_HOURS
    since = (now - timedelta(hours=LOOKBACK_HOURS)).isoformat()
    run_rows = []
    for repo in REPOS:
        try:
            resp = gh_api(
                f"/repos/{ORG}/{repo}/actions/runs",
                gh_token,
                params={"per_page": 100, "created": f">{since}"},
            )
        except Exception as e:
            print(f"WARN runs {repo}: {e}", file=sys.stderr)
            continue
        for r in resp.get("workflow_runs", []):
            wf_file = (r.get("path") or "").rsplit("/", 1)[-1]
            timeout_min = timeouts.get((repo, wf_file), 360)
            started = r.get("run_started_at") or r.get("created_at")
            updated = r.get("updated_at")
            duration_min = None
            if started and updated:
                s = datetime.fromisoformat(started.replace("Z", "+00:00"))
                u = datetime.fromisoformat(updated.replace("Z", "+00:00"))
                duration_min = round((u - s).total_seconds() / 60, 2)
            conclusion = r.get("conclusion")
            log_text = None
            if conclusion in ("failure", "cancelled", "timed_out"):
                log_text = gh_logs_tail(repo, r["id"], gh_token)
            cls = classify(conclusion, duration_min, timeout_min, log_text)
            fp = error_fingerprint(log_text) if cls in ("failed", "hard-timeout") else ""
            run_rows.append({
                "run_id": r["id"],
                "repo": repo,
                "workflow_file": wf_file,
                "workflow_name": r.get("name"),
                "conclusion": conclusion,
                "classification": cls,
                "started_at": started,
                "duration_min": duration_min,
                "timeout_min": timeout_min,
                "error_signature": signature(repo, wf_file, cls, fp) if cls != "healthy" else None,
                "run_url": r.get("html_url"),
                "head_sha": r.get("head_sha"),
                "log_preview": log_text,
                "collected_at": now.isoformat(),
            })

    for i in range(0, len(run_rows), 50):
        sb_upsert("triage_workflow_runs", run_rows[i:i + 50], "run_id", sb_url, sb_key)
    print(f"workflow_runs: {len(run_rows)} rows")


if __name__ == "__main__":
    try:
        collect()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
