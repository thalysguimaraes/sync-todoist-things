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

log_color "📱 Fetching unsynced Todoist tasks (Things URL)..." "$BLUE"
todoist_response=$(curl -s "${WORKER_URL}/inbox?format=url&include_all=false")

if [ $? -ne 0 ] || echo "$todoist_response" | jq -e '.error' > /dev/null; then
    log_color "❌ Failed to fetch tasks from Todoist" "$RED"
    exit 1
fi

things_url=$(echo "$todoist_response" | jq -r '.url')
task_count=$(echo "$todoist_response" | jq -r '.count')

log_color "📊 Found $task_count unsynced tasks in Todoist" "$BLUE"

if [ "$task_count" -eq 0 ]; then
    log_color "✨ No new tasks to sync - all tasks are already synced!" "$GREEN"
    exit 0
fi

echo
echo "Tasks to sync:"
echo "$todoist_response" | jq -r '.tasks[] | "   • \(.attributes.title)"'
echo

log_color "📥 Importing tasks into Things..." "$YELLOW"
open "$things_url"
sleep 2

log_color "📝 Marking imported tasks as synced in Todoist..." "$BLUE"
mark_response=$(curl -s -X POST "${WORKER_URL}/inbox/mark-synced")

if [ $? -eq 0 ] && ! echo "$mark_response" | jq -e '.error' > /dev/null; then
    marked_count=$(echo "$mark_response" | jq -r '.count')
    log_color "✅ Marked $marked_count tasks as synced in Todoist" "$GREEN"
else
    log_color "⚠️  Warning: Could not mark tasks as synced in Todoist" "$YELLOW"
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
