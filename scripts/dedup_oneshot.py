#!/usr/bin/env python3
"""
One-shot dedup script.

Finds duplicate records in the intel-collector target tables (AI News,
Platform Updates, Deals, Skills) — grouping by primary field — and deletes
all but the earliest record per group.

Safe to re-run: if no duplicates exist, it deletes nothing.

Env vars required:
  AIRTABLE_API_KEY  PAT with data.records:read/write on app6biS7yjV6XzFVG
"""
import json
import os
import sys
import time
from collections import defaultdict
from urllib import request, error

BASE = "app6biS7yjV6XzFVG"

TABLES = [
    ("AI News",          "tbl4IUWP09vzchU5t", "fldLZrIAoWNarkPpz"),
    ("Platform Updates", "tblW6XV9X5gBrghOv", "fld6MygJickboWiDR"),
    ("Deals",            "tbl9a3WVIhW7NddYz", "fldd6P0A3QmYImHdn"),
    ("Skills",           "tblRYHxXNItKHXqg7", "fldWkR24Xvv9QwlhC"),
]

UA = "Mozilla/5.0 dedup-oneshot"
SLEEP = 0.3


def http(url, method="GET", body=None):
    headers = {"Authorization": f"Bearer {os.environ['AIRTABLE_API_KEY']}",
               "User-Agent": UA}
    if body is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(body).encode()
    req = request.Request(url, method=method, headers=headers, data=body)
    try:
        with request.urlopen(req, timeout=30) as r:
            return r.status, r.read()
    except error.HTTPError as e:
        return e.code, e.read()


def list_all(table):
    rows = []
    offset = None
    while True:
        qs = "pageSize=100&returnFieldsByFieldId=true"
        if offset:
            qs += f"&offset={offset}"
        status, body = http(f"https://api.airtable.com/v0/{BASE}/{table}?{qs}")
        if status >= 400:
            print(f"FATAL list {table}: {status} {body[:300]!r}", file=sys.stderr)
            sys.exit(1)
        data = json.loads(body)
        rows.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
        time.sleep(SLEEP)
    return rows


def delete_batch(table, record_ids):
    if not record_ids:
        return 0
    total = 0
    for i in range(0, len(record_ids), 10):
        batch = record_ids[i:i + 10]
        qs = "&".join(f"records[]={r}" for r in batch)
        status, body = http(f"https://api.airtable.com/v0/{BASE}/{table}?{qs}",
                            method="DELETE")
        if status >= 400:
            print(f"WARN delete {table}: {status} {body[:300]!r}", file=sys.stderr)
            continue
        deleted = json.loads(body).get("records", [])
        total += len(deleted)
        time.sleep(SLEEP)
    return total


def main():
    for label, table, primary in TABLES:
        rows = list_all(table)
        groups = defaultdict(list)
        for r in rows:
            v = (r.get("fields", {}) or {}).get(primary)
            if isinstance(v, str):
                groups[v.strip().lower()].append((r["createdTime"], r["id"]))

        to_delete = []
        for _, entries in groups.items():
            if len(entries) > 1:
                entries.sort()  # earliest createdTime first
                for _ct, rec_id in entries[1:]:
                    to_delete.append(rec_id)

        print(f"{label}: {len(rows)} rows, {len(groups)} unique titles, "
              f"{len(to_delete)} duplicates flagged")
        if to_delete:
            deleted = delete_batch(table, to_delete)
            print(f"{label}: deleted {deleted}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
