# High-Impact Improvements

Status legend: [ ] TODO, [~] In progress, [x] Done

## 1) Created-mappings callback to fix Todoist→Things ID gaps
- [x] Update importer to return mapping pairs `{thingsId, todoistId}`
- [x] New endpoint `POST /things/created-mappings` to finalize mappings:
  - Update batch state mapping with real `thingsId`
  - Add `[things-id:...]` to Todoist description
- [ ] Wire scripts/sync-bidirectional.sh to parse `MAPPINGS:[...]` from importer output and POST to `/things/created-mappings`

## 2) Batch-aware completion sync (Things→Todoist)
- [x] `/things/sync-completed` now prefers batch mapping via `thingsId`; falls back to legacy KV and description scan
- [ ] Add a Things completions AppleScript that returns only completed-within-window items robustly (exists: `scripts/read-things-completed.applescript`)

## 3) Todoist→Things completion and deletion
- [x] Add Todoist webhook endpoint (e.g. `/webhook/todoist`) and dispatcher stub to capture `item:completed`, `item:deleted`
- [ ] Store events to KV and have mac agent apply via AppleScript (mark done/delete by `thingsId`)
- [ ] AppleScripts: `mark-things-done.applescript`, `delete-things-tasks.applescript`

## 4) Things→Todoist deletion
- [x] AppleScript to read recently deleted/trashed in Things (`scripts/read-things-deleted.applescript`)
- [x] Endpoint `POST /things/sync-deleted` to close matching Todoist tasks via mapping
- [x] Wire into sync script (Step 4)

## 5) Mapping hygiene and repair
- [ ] Daily cron to auto-clean orphaned mappings and set mapping status (active/completed/deleted)
- [ ] Extend `/sync/verify` to propose auto-fixes + guarded `/sync/repair`

## 6) Observability & safeguards
- [ ] Metrics for created-mapping callbacks, completion/deletion flows
- [ ] Dry-run support for destructive repair endpoints

## Notes
- These changes make state transitions (create/complete/delete) bidirectional and resilient by ensuring both sides store cross-IDs and by preferring the batch mapping state.
