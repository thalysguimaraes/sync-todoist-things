#!/bin/bash

# Bidirectional sync between Todoist and Things
# This script syncs in both directions, preventing duplicates

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
LOG_FILE="$HOME/Library/Logs/todoist-things-sync.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Function to check if Things is running
check_things_running() {
    if ! osascript -e 'tell application "System Events" to (name of processes) contains "Things3"' 2>/dev/null | grep -q "true"; then
        log "ERROR: Things3 is not running. Please open Things3 and try again."
        echo "ERROR: Things3 is not running. Please open Things3 and try again."
        exit 1
    fi
}

# Function to run AppleScript with timeout and retry
run_applescript() {
    local script_path="$1"
    local args="${2:-}"
    local max_retries=3
    local retry_count=0
    local timeout_seconds=30
    
    while [ $retry_count -lt $max_retries ]; do
        if [ -n "$args" ]; then
            result=$(timeout $timeout_seconds "$script_path" "$args" 2>&1)
        else
            result=$(timeout $timeout_seconds "$script_path" 2>&1)
        fi
        
        if [ $? -eq 0 ]; then
            echo "$result"
            return 0
        elif [ $? -eq 124 ]; then
            log "WARNING: AppleScript timed out after ${timeout_seconds}s (attempt $((retry_count + 1))/$max_retries)"
            retry_count=$((retry_count + 1))
            sleep 2
        else
            log "ERROR: AppleScript failed: $result"
            return 1
        fi
    done
    
    log "ERROR: AppleScript failed after $max_retries attempts"
    return 1
}

# Start bidirectional sync
log "Starting bidirectional sync..."

# Check if Things is running
check_things_running

# STEP 1: Sync from Todoist to Things
log "Step 1: Syncing from Todoist → Things"

# Fetch only unsynced tasks from Todoist
todoist_response=$(curl -s "${WORKER_URL}/inbox?format=url")

if [ $? -ne 0 ]; then
    log "ERROR: Failed to fetch tasks from Todoist"
    exit 1
fi

# Extract data
todoist_url=$(echo "$todoist_response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
todoist_count=$(echo "$todoist_response" | grep -o '"count":[0-9]*' | cut -d':' -f2)
todoist_mappings=$(echo "$todoist_response" | grep -o '"taskMappings":\[[^]]*\]' | sed 's/"taskMappings"://')

if [ "$todoist_count" -gt 0 ] 2>/dev/null; then
    log "Found $todoist_count new tasks in Todoist"
    
    # Get the full task data in flat format for AppleScript importer
    todoist_tasks=$(curl -s "${WORKER_URL}/inbox?format=flat&include_all=false")
    
    # Import tasks using AppleScript with duplicate prevention
    import_result=$(run_applescript "${SCRIPT_DIR}/import-todoist-tasks.applescript" "$todoist_tasks")
    if [ $? -ne 0 ]; then
        log "ERROR: Failed to import tasks to Things"
    else
        log "Import result: $import_result"
    fi
    
    # Mark as synced in Todoist only if at least one task was imported
    imported_num=$(echo "$import_result" | sed -n 's/.*Imported \([0-9][0-9]*\) tasks.*/\1/p')
    if [[ -n "$imported_num" && "$imported_num" -gt 0 ]]; then
        curl -s -X POST "${WORKER_URL}/inbox/mark-synced" > /dev/null
        log "Marked $imported_num tasks as synced in Todoist"
    else
        log "No tasks imported to Things; not marking Todoist tasks as synced"
    fi
else
    log "No new tasks in Todoist to sync"
fi

# STEP 2: Sync from Things to Todoist
log "Step 2: Syncing from Things → Todoist"

# Read tasks from Things inbox using AppleScript
things_tasks=$(run_applescript "${SCRIPT_DIR}/read-things-inbox.applescript")

if [ $? -ne 0 ] || [ -z "$things_tasks" ] || [ "$things_tasks" = "[]" ]; then
    log "No new tasks in Things to sync"
else
    # Count tasks
    things_count=$(echo "$things_tasks" | grep -o '"id"' | wc -l | tr -d ' ')
    log "Found $things_count new tasks in Things"
    
    # Send to Todoist via Worker
    sync_response=$(curl -s -X POST "${WORKER_URL}/things/sync" \
        -H "Content-Type: application/json" \
        -d "$things_tasks")
    
    if [ $? -eq 0 ]; then
        # Extract summary values from nested JSON structure
        created=$(echo "$sync_response" | grep -o '"summary":{[^}]*"created":[0-9]*' | grep -o '"created":[0-9]*' | cut -d':' -f2)
        existing=$(echo "$sync_response" | grep -o '"summary":{[^}]*"existing":[0-9]*' | grep -o '"existing":[0-9]*' | cut -d':' -f2)
        errors=$(echo "$sync_response" | grep -o '"summary":{[^}]*"errors":[0-9]*' | grep -o '"errors":[0-9]*' | cut -d':' -f2)
        
        log "Things → Todoist: $created created, $existing already existed, $errors errors"
        
        # Tag synced tasks in Things
        if [ "$created" -gt 0 ] 2>/dev/null; then
            # Extract successful mappings from the response using jq
            # First check if jq is available, otherwise use a more robust grep approach
            if command -v jq > /dev/null 2>&1; then
                task_mappings=$(echo "$sync_response" | jq -c '[.results[] | select(.status == "created") | {thingsId: .id, todoistId: .todoist_id}]')
            else
                # More robust extraction without jq
                task_mappings=$(echo "$sync_response" | 
                    perl -ne 'while (/"id":"([^"]+)"[^}]*"status":"created"[^}]*"todoist_id":"([^"]+)"/g) { print "{\"thingsId\":\"$1\",\"todoistId\":\"$2\"}," }' | 
                    sed 's/,$//' | 
                    sed 's/^/[/' | 
                    sed 's/$/]/')
            fi
            
            if [ -n "$task_mappings" ] && [ "$task_mappings" != "[]" ] && [ "$task_mappings" != "null" ]; then
                log "Tagging $created newly synced tasks in Things with mappings: $task_mappings"
                tag_result=$("${SCRIPT_DIR}/tag-things-synced.applescript" "$task_mappings" 2>&1)
                log "Things tagging result: $tag_result"
            else
                log "WARNING: Created $created tasks but could not extract mappings for tagging"
            fi
        fi
    else
        log "ERROR: Failed to sync tasks from Things to Todoist"
    fi
fi

# STEP 3: Sync completed tasks from Things to Todoist
log "Step 3: Syncing completed tasks from Things → Todoist"

# Read completed tasks from Things (last 24 hours)
completed_tasks=$("${SCRIPT_DIR}/read-things-completed.applescript" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$completed_tasks" ] || [ "$completed_tasks" = "[]" ]; then
    log "No recently completed tasks in Things to sync"
else
    # Count completed tasks
    completed_count=$(echo "$completed_tasks" | grep -o '"thingsId"' | wc -l | tr -d ' ')
    log "Found $completed_count recently completed tasks in Things"
    
    # Send to Todoist via Worker
    completion_response=$(curl -s -X POST "${WORKER_URL}/things/sync-completed" \
        -H "Content-Type: application/json" \
        -d "$completed_tasks")
    
    if [ $? -eq 0 ]; then
        # Extract summary from response
        completed=$(echo "$completion_response" | grep -o '"summary":{[^}]*"completed":[0-9]*' | grep -o '"completed":[0-9]*' | cut -d':' -f2)
        not_found=$(echo "$completion_response" | grep -o '"summary":{[^}]*"notFound":[0-9]*' | grep -o '"notFound":[0-9]*' | cut -d':' -f2)
        errors=$(echo "$completion_response" | grep -o '"summary":{[^}]*"errors":[0-9]*' | grep -o '"errors":[0-9]*' | cut -d':' -f2)
        
        log "Completed tasks sync: $completed marked done, $not_found not found, $errors errors"
    else
        log "ERROR: Failed to sync completed tasks from Things to Todoist"
    fi
fi

log "Bidirectional sync completed"

# Summary
echo "Sync completed at $(date '+%Y-%m-%d %H:%M:%S')"
echo "Check logs at: $LOG_FILE"