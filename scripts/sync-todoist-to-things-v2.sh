#!/bin/bash

# Robust Todoist → Things sync with fingerprint-based deduplication
# Uses the worker API to ensure no duplicates are created

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-http://localhost:8787}"
LOG_FILE="$HOME/Library/Logs/todoist-things-sync.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_color() {
    echo -e "${2}[$(date '+%Y-%m-%d %H:%M:%S')] $1${NC}" | tee -a "$LOG_FILE"
}

echo "🔄 Robust Todoist → Things Sync (v2)"
echo "====================================="
echo

# Check worker availability
log_color "Checking worker availability..." "$BLUE"
if ! curl -f -s "$WORKER_URL/health" > /dev/null; then
    log_color "❌ Worker not available at $WORKER_URL" "$RED"
    echo "Please start the worker with: npm run dev"
    exit 1
fi
log_color "✅ Worker is responding" "$GREEN"
echo

# Get unsynced tasks from Todoist
log_color "📱 Fetching unsynced Todoist tasks..." "$BLUE"
todoist_response=$(curl -s "${WORKER_URL}/inbox?include_all=false")

if [ $? -ne 0 ]; then
    log_color "❌ Failed to fetch tasks from Todoist" "$RED"
    exit 1
fi

task_count=$(echo "$todoist_response" | jq length)
log_color "📊 Found $task_count unsynced tasks in Todoist" "$BLUE"

if [ "$task_count" -eq 0 ]; then
    log_color "✨ No new tasks to sync - all tasks are already synced!" "$GREEN"
    exit 0
fi

echo
echo "Tasks to sync:"
echo "$todoist_response" | jq -r '.[] | "   • \(.attributes.title)"'
echo

# Convert to Things format with enhanced deduplication check
log_color "🔄 Converting tasks to Things format..." "$BLUE"
things_tasks_json=$(echo "$todoist_response" | jq '[.[] | {
    id: ("todoist-" + (.attributes.title | gsub("[^a-zA-Z0-9]"; "") | ascii_downcase)),
    title: .attributes.title,
    notes: .attributes.notes // "",
    due: .attributes.deadline // null,
    tags: (.attributes.tags // [] | map(select(. != "synced-to-things" and . != "synced-from-things")))
}]')

# Import to Things using the worker's fingerprint-based deduplication
log_color "📥 Importing to Things with deduplication..." "$YELLOW"
import_response=$(curl -s -X POST "${WORKER_URL}/things/sync" \
  -H "Content-Type: application/json" \
  -d "$things_tasks_json")

import_exit_code=$?

if [ $import_exit_code -ne 0 ]; then
    log_color "❌ Import request failed" "$RED"
    exit 1
fi

# Parse import results
if echo "$import_response" | jq -e '.error' > /dev/null; then
    log_color "❌ Import failed:" "$RED"
    echo "$import_response" | jq -r '.error + ": " + .message'
    exit 1
fi

# Extract import statistics
created=$(echo "$import_response" | jq -r '.summary.created')
existing=$(echo "$import_response" | jq -r '.summary.existing')
errors=$(echo "$import_response" | jq -r '.summary.errors')
total=$(echo "$import_response" | jq -r '.summary.total')

log_color "✅ Import completed successfully!" "$GREEN"
echo
log_color "📊 Import Results:" "$BLUE"
echo "   ✨ Created: $created tasks"
echo "   🔄 Already existed: $existing tasks"
echo "   ❌ Errors: $errors tasks"
echo "   📝 Total processed: $total tasks"
echo

# Show details for created and existing tasks
if [ "$created" -gt 0 ]; then
    echo "📝 Newly created tasks:"
    echo "$import_response" | jq -r '.results[] | select(.status == "created") | "   • \(.title)"'
    echo
fi

if [ "$existing" -gt 0 ]; then
    echo "🔄 Tasks that already existed (duplicates prevented):"
    echo "$import_response" | jq -r '.results[] | select(.status == "already_exists") | "   • \(.title) (detected via \(.match_type) match)"'
    echo
fi

if [ "$errors" -gt 0 ]; then
    echo "❌ Tasks with errors:"
    echo "$import_response" | jq -r '.results[] | select(.status == "error") | "   • \(.title): \(.message)"'
    echo
fi

# Mark successfully imported tasks as synced in Todoist
if [ "$created" -gt 0 ]; then
    log_color "📝 Marking imported tasks as synced in Todoist..." "$BLUE"
    mark_response=$(curl -s -X POST "${WORKER_URL}/inbox/mark-synced")
    
    if [ $? -eq 0 ] && ! echo "$mark_response" | jq -e '.error' > /dev/null; then
        marked_count=$(echo "$mark_response" | jq -r '.count')
        log_color "✅ Marked $marked_count tasks as synced in Todoist" "$GREEN"
    else
        log_color "⚠️  Warning: Could not mark tasks as synced in Todoist" "$YELLOW"
    fi
fi

echo
log_color "🎉 Todoist → Things sync completed successfully!" "$GREEN"
log_color "📁 Sync logs saved to: $LOG_FILE" "$BLUE"

# Verify no duplicates were created
log_color "🔍 Verifying no duplicates were created..." "$BLUE"
duplicates_json=$("${SCRIPT_DIR}/find-duplicates-things.applescript")
duplicate_count=$(echo "$duplicates_json" | jq length)

if [ "$duplicate_count" -eq 0 ]; then
    log_color "✅ No duplicates detected - sync was clean!" "$GREEN"
else
    log_color "⚠️  Warning: $duplicate_count duplicate sets detected after sync" "$YELLOW"
    echo "Consider running: ./scripts/cleanup-things-duplicates.sh"
fi

echo
echo "🔄 Sync completed at $(date)"
