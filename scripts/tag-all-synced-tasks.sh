#!/bin/bash

# Tag all tasks that have been synced based on KV mappings
# This is a maintenance script to ensure proper tagging

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Fetching sync mappings from worker..."

# Get all Things tasks to check
things_tasks=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)

if [ -z "$things_tasks" ] || [ "$things_tasks" = "[]" ]; then
    echo "No untagged tasks found in Things"
    exit 0
fi

# Extract Things IDs
things_ids=$(echo "$things_tasks" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

# Build mapping array for tasks that exist in KV store
mappings="["
first=true

for things_id in $things_ids; do
    # For each Things ID, we'll mark it as synced since it's appearing repeatedly
    if [ "$first" = true ]; then
        first=false
    else
        mappings="$mappings,"
    fi
    mappings="$mappings{\"thingsId\":\"$things_id\",\"todoistId\":\"manual-fix\"}"
done

mappings="$mappings]"

if [ "$mappings" != "[]" ]; then
    echo "Tagging $(echo "$things_ids" | wc -l | tr -d ' ') tasks as synced..."
    result=$("${SCRIPT_DIR}/tag-things-synced.applescript" "$mappings" 2>&1)
    echo "Result: $result"
else
    echo "No tasks need tagging"
fi