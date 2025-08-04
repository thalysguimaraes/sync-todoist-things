#!/bin/bash

# Robust bidirectional sync between Todoist and Things (v2)
# Uses fingerprint-based deduplication to prevent any duplicates

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

echo "🔄 Robust Bidirectional Sync (v2)"
echo "=================================="
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

# STEP 1: Sync from Todoist → Things
log_color "📱 STEP 1: Syncing Todoist → Things" "$BLUE"
echo "=========================================="

# Use the new robust sync script
"${SCRIPT_DIR}/sync-todoist-to-things-v2.sh"
todoist_sync_result=$?

if [ $todoist_sync_result -ne 0 ]; then
    log_color "❌ Todoist → Things sync failed" "$RED"
    exit 1
fi

echo
echo

# STEP 2: Sync from Things → Todoist  
log_color "📋 STEP 2: Syncing Things → Todoist" "$BLUE"
echo "=========================================="

# Read unsynced tasks from Things
log_color "📋 Reading unsynced tasks from Things..." "$BLUE"
things_tasks_json=$("${SCRIPT_DIR}/read-things-inbox.applescript")

if [ $? -ne 0 ]; then
    log_color "❌ Failed to read tasks from Things" "$RED"
    exit 1
fi

# Count tasks
things_count=$(echo "$things_tasks_json" | jq length 2>/dev/null || echo "0")
log_color "📊 Found $things_count unsynced tasks in Things" "$BLUE"

if [ "$things_count" -gt 0 ]; then
    echo
    echo "Tasks to sync to Todoist:"
    echo "$things_tasks_json" | jq -r '.[] | "   • \(.title)"'
    echo

    # Sync to Todoist using fingerprint-based deduplication
    log_color "📤 Syncing to Todoist with deduplication..." "$YELLOW"
    things_sync_response=$(curl -s -X POST "${WORKER_URL}/things/sync" \
      -H "Content-Type: application/json" \
      -d "$things_tasks_json")

    if [ $? -ne 0 ]; then
        log_color "❌ Things → Todoist sync failed" "$RED"
        exit 1
    fi

    # Parse sync results
    if echo "$things_sync_response" | jq -e '.error' > /dev/null; then
        log_color "❌ Things sync failed:" "$RED"
        echo "$things_sync_response" | jq -r '.error + ": " + .message'
        exit 1
    fi

    # Extract statistics
    created=$(echo "$things_sync_response" | jq -r '.summary.created')
    existing=$(echo "$things_sync_response" | jq -r '.summary.existing')
    errors=$(echo "$things_sync_response" | jq -r '.summary.errors')

    log_color "✅ Things → Todoist sync completed!" "$GREEN"
    echo "   ✨ Created: $created tasks"
    echo "   🔄 Already existed: $existing tasks"
    echo "   ❌ Errors: $errors tasks"
    
    # Tag synced tasks in Things
    if [ "$created" -gt 0 ]; then
        log_color "📝 Tagging synced tasks in Things..." "$BLUE"
        task_mappings=$(echo "$things_sync_response" | jq -r '.results[] | select(.status == "created") | "\(.id):\(.todoist_id)"' | tr '\n' ' ')
        
        if [ ! -z "$task_mappings" ]; then
            tag_result=$("${SCRIPT_DIR}/tag-things-synced.applescript" "$task_mappings" 2>&1)
            log_color "✅ Tagged $created tasks in Things" "$GREEN"
        fi
    fi
else
    log_color "✨ No new tasks to sync from Things" "$GREEN"
fi

echo
echo

# STEP 3: Check for completed tasks sync
log_color "✅ STEP 3: Syncing completed tasks" "$BLUE"
echo "======================================="

# Read completed tasks from Things
log_color "📋 Reading recently completed tasks from Things..." "$BLUE"
completed_tasks_json=$("${SCRIPT_DIR}/read-things-completed.applescript")

if [ $? -eq 0 ] && [ ! -z "$completed_tasks_json" ] && [ "$completed_tasks_json" != "[]" ]; then
    completed_count=$(echo "$completed_tasks_json" | jq length 2>/dev/null || echo "0")
    
    if [ "$completed_count" -gt 0 ]; then
        log_color "📊 Found $completed_count recently completed tasks" "$BLUE"
        
        # Sync completed tasks
        completion_response=$(curl -s -X POST "${WORKER_URL}/things/sync-completed" \
          -H "Content-Type: application/json" \
          -d "$completed_tasks_json")
        
        if [ $? -eq 0 ] && ! echo "$completion_response" | jq -e '.error' > /dev/null; then
            completed_synced=$(echo "$completion_response" | jq -r '.summary.completed')
            log_color "✅ Synced $completed_synced completed tasks to Todoist" "$GREEN"
        else
            log_color "⚠️  Warning: Could not sync completed tasks" "$YELLOW"
        fi
    else
        log_color "✨ No recently completed tasks to sync" "$GREEN"
    fi
else
    log_color "✨ No recently completed tasks to sync" "$GREEN"
fi

echo
echo

# STEP 4: Final verification
log_color "🔍 STEP 4: Final verification" "$BLUE"
echo "=============================="

# Check for any duplicates
log_color "🔍 Checking for duplicates in Things..." "$BLUE"
duplicates_json=$("${SCRIPT_DIR}/find-duplicates-things.applescript")
duplicate_count=$(echo "$duplicates_json" | jq length)

if [ "$duplicate_count" -eq 0 ]; then
    log_color "✅ No duplicates detected - sync was completely clean!" "$GREEN"
else
    log_color "⚠️  Warning: $duplicate_count duplicate sets detected" "$YELLOW"
    echo "Duplicates found:"
    echo "$duplicates_json" | jq -r '.[] | "   • \(.name)"'
    echo
    log_color "Recommend running: ./scripts/cleanup-things-duplicates.sh" "$YELLOW"
fi

# Get sync status
log_color "📊 Getting sync system status..." "$BLUE"
status_response=$(curl -s "$WORKER_URL/sync/status")
if [ $? -eq 0 ]; then
    hash_mappings=$(echo "$status_response" | jq -r '.fingerprint.hashMappings')
    migration_complete=$(echo "$status_response" | jq -r '.migration.isComplete')
    
    echo "   • Fingerprint mappings: $hash_mappings"
    echo "   • Migration complete: $migration_complete"
fi

echo
log_color "🎉 Bidirectional sync completed successfully!" "$GREEN"
log_color "📁 Sync logs saved to: $LOG_FILE" "$BLUE"
echo
echo "🔄 Sync completed at $(date)"
