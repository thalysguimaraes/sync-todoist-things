#!/bin/bash

# Deduplicate Todoist inbox tasks by normalized title (case/whitespace)
# Requires TODOIST_API_TOKEN in env. Uses Todoist REST API directly.

set -euo pipefail

API_URL="https://api.todoist.com/rest/v2"
TOKEN="${TODOIST_API_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: TODOIST_API_TOKEN is not set in the environment." >&2
  echo "Export your token and re-run, e.g.: export TODOIST_API_TOKEN=xxxxx" >&2
  exit 1
fi

jq_installed=0
if command -v jq >/dev/null 2>&1; then jq_installed=1; fi

# Get inbox project id
inbox_id=$(curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/projects" | jq -r '.[] | select(.is_inbox_project==true) | .id')
if [[ -z "$inbox_id" || "$inbox_id" == "null" ]]; then
  echo "ERROR: Could not determine Todoist Inbox project id" >&2
  exit 1
fi

# Fetch tasks in inbox
tasks_json=$(curl -s -H "Authorization: Bearer $TOKEN" "$API_URL/tasks?project_id=$inbox_id")

# Build map of normalized title -> array of task objects
normalize() {
  # lowercase, trim, collapse spaces
  printf "%s" "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//'
}

# If jq present, use it to compute duplicates robustly
if [[ $jq_installed -eq 1 ]]; then
  dup_groups=$(echo "$tasks_json" | jq -c 'group_by(.content | ascii_downcase | gsub("\\s+"; " ") | gsub("^ "; "") | gsub(" $"; "")) | map(select(length>1))')
  dup_count=$(echo "$dup_groups" | jq 'map(length) | add // 0')
  if [[ ${dup_count:-0} -eq 0 ]]; then
    echo "No Todoist duplicates found."
    exit 0
  fi

  echo "Found duplicate groups: $(echo "$dup_groups" | jq 'length')"
  echo "$dup_groups" | jq -r '.[] | "- " + (.[0].content | tostring) + " -> keep 1, delete " + ((length-1)|tostring) + ""'

  # Delete duplicates (keep the earliest created_at)
  deleted=0
  while IFS= read -r group; do
    # sort by created_at ascending and skip first
    to_delete_ids=$(echo "$group" | jq -r 'sort_by(.created_at) | .[1:] | .[].id')
    for id in $to_delete_ids; do
      curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$API_URL/tasks/$id" >/dev/null
      deleted=$((deleted+1))
    done
  done < <(echo "$dup_groups" | jq -c '.[]')
  echo "Deleted $deleted duplicate tasks from Todoist."
  exit 0
else
  # Fallback without jq: simple best-effort dedupe by title text
  echo "jq not found; performing simple duplicate check."
  mapfile -t titles < <(echo "$tasks_json" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p')
  declare -A seen
  declare -a delete_ids
  i=0
  while read -r line; do
    :
  done <<< "" # placeholder to satisfy shells without nullglob
  # Iterate pairing content with ids
  ids=($(echo "$tasks_json" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'))
  idx=0
  while IFS= read -r title; do
    norm=$(normalize "$title")
    if [[ -n "${seen[$norm]:-}" ]]; then
      delete_ids+=("${ids[$idx]}")
    else
      seen[$norm]=1
    fi
    idx=$((idx+1))
  done < <(printf "%s\n" "${titles[@]}")
  if [[ ${#delete_ids[@]} -eq 0 ]]; then
    echo "No Todoist duplicates found."
    exit 0
  fi
  for id in "${delete_ids[@]}"; do
    curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$API_URL/tasks/$id" >/dev/null || true
  done
  echo "Deleted ${#delete_ids[@]} duplicate tasks from Todoist."
fi
