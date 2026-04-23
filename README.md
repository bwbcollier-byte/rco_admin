# rco_admin

Ops / admin repo for the `bwbcollier-byte` org.

## Triage collector

A GitHub Action (`.github/workflows/triage-collector.yml`) that runs hourly and
writes workflow run data + Actions enablement state to Supabase tables
`triage_workflow_runs` and `triage_repo_state`. Powers the morning triage brief.

Required repository secrets:
- `TRIAGE_GH_TOKEN` — PAT with `repo` + `read:org` scopes
- `TRIAGE_SUPABASE_URL` — `https://<project-ref>.supabase.co`
- `TRIAGE_SUPABASE_KEY` — Supabase service_role key

Workflow catalog is embedded in `scripts/triage_collector.py` (the `WORKFLOWS` list).
Keep in sync with `~/.claude/triage-config.json` on Ben's machine.
