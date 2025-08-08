#!/bin/bash

# Enhanced bidirectional sync between Todoist and Things with configuration support
# This script syncs in both directions with filtering and conflict resolution

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
LOG_FILE="$HOME/Library/Logs/todoist-things-sync.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Function to send notification
notify() {
    osascript -e "display notification \"$2\" with title \"$1\""
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
    shift  # Remove first argument
    local args="$@"  # Get all remaining arguments
    local max_retries=3
    local retry_count=0
    local timeout_seconds=30
    
    while [ $retry_count -lt $max_retries ]; do
        if [ -n "$args" ]; then
            result=$(timeout $timeout_seconds "$script_path" $args 2>&1)
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

# Function to fetch sync configuration
fetch_config() {
    local config_response=$(curl -s "${WORKER_URL}/config")
    
    if [ $? -ne 0 ]; then
        log "WARNING: Failed to fetch configuration, using defaults"
        echo "{}"
        return 1
    fi
    
    echo "$config_response"
    return 0
}

# Function to parse configuration
parse_config() {
    local config="$1"
    
    # Extract filter settings
    ENABLED_PROJECTS=$(echo "$config" | grep -o '"enabledProjects":\[[^]]*\]' | sed 's/"enabledProjects":\[//;s/\]//;s/"//g;s/,/ /g' | tr ' ' ',')
    ENABLED_TAGS=$(echo "$config" | grep -o '"enabledTags":\[[^]]*\]' | sed 's/"enabledTags":\[//;s/\]//;s/"//g;s/,/ /g' | tr ' ' ',')
    EXCLUDED_TAGS=$(echo "$config" | grep -o '"excludedTags":\[[^]]*\]' | sed 's/"excludedTags":\[//;s/\]//;s/"//g;s/,/ /g' | tr ' ' ',')
    
    # Default excluded tags if not set
    if [ -z "$EXCLUDED_TAGS" ]; then
        EXCLUDED_TAGS="synced-from-todoist,synced-to-todoist"
    fi
    
    log "Configuration loaded - Projects: $ENABLED_PROJECTS, Tags: $ENABLED_TAGS, Excluded: $EXCLUDED_TAGS"
}

# Start sync
log "=== Starting bidirectional sync ==="
check_things_running

# Fetch and parse configuration
CONFIG=$(fetch_config)
parse_config "$CONFIG"

# Check for sync lock
lock_status=$(curl -s "${WORKER_URL}/sync/status" | grep -o '"syncLocked":[^,]*' | cut -d':' -f2)
if [ "$lock_status" = "true" ]; then
    log "WARNING: Another sync is in progress, skipping"
    exit 0
fi

# STEP 1: Sync from Todoist to Things
log "Step 1: Syncing from Todoist → Things"

# Fetch only unsynced tasks from Todoist
todoist_response=$(curl -s "${WORKER_URL}/inbox?format=url")

if [ $? -ne 0 ]; then
    log "ERROR: Failed to fetch tasks from Todoist"
    notify "Todoist-Things Sync" "Failed to fetch tasks from Todoist"
    exit 1
fi

# Extract data
todoist_url=$(echo "$todoist_response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
todoist_count=$(echo "$todoist_response" | grep -o '"count":[0-9]*' | cut -d':' -f2)

if [ "$todoist_count" -gt 0 ] 2>/dev/null; then
    log "Found $todoist_count new tasks in Todoist"
    
    # Get the full task data in flat format for AppleScript importer
    todoist_tasks=$(curl -s "${WORKER_URL}/inbox?format=flat&include_all=false")
    
    # Import tasks using AppleScript with duplicate prevention
    import_result=$(run_applescript "${SCRIPT_DIR}/import-todoist-tasks.applescript" "$todoist_tasks")
    if [ $? -ne 0 ]; then
        log "ERROR: Failed to import tasks to Things"
        notify "Todoist-Things Sync" "Failed to import tasks to Things"
    else
        log "Import result: $import_result"
    fi
    
    # Mark as synced in Todoist
    imported_num=$(echo "$import_result" | sed -n 's/.*Imported \([0-9][0-9]*\) tasks.*/\1/p')
    if [[ -n "$imported_num" && "$imported_num" -gt 0 ]]; then
        # Generate request ID for idempotency
        REQUEST_ID="todoist-sync-$(date +%s)-$$"
        curl -s -X POST "${WORKER_URL}/inbox/mark-synced" \
            -H "X-Request-Id: $REQUEST_ID" > /dev/null
        log "Marked $imported_num tasks as synced in Todoist"
    fi
else
    log "No new tasks in Todoist to sync"
fi

# STEP 2: Sync from Things to Todoist with filtering
log "Step 2: Syncing from Things → Todoist (filtered)"

# Read tasks from Things with filtering
if [ -f "${SCRIPT_DIR}/read-things-inbox-filtered.applescript" ]; then
    things_tasks=$(run_applescript "${SCRIPT_DIR}/read-things-inbox-filtered.applescript" \
        "$ENABLED_PROJECTS" "$ENABLED_TAGS" "$EXCLUDED_TAGS")
else
    # Fallback to original script if filtered version doesn't exist
    things_tasks=$(run_applescript "${SCRIPT_DIR}/read-things-inbox.applescript")
fi

if [ $? -ne 0 ]; then
    log "ERROR: Failed to read tasks from Things"
    notify "Todoist-Things Sync" "Failed to read tasks from Things"
    exit 1
fi

# Count tasks
task_count=$(echo "$things_tasks" | grep -o '"id"' | wc -l | tr -d ' ')

if [ "$task_count" -gt 0 ]; then
    log "Found $task_count tasks in Things to sync"
    
    # Generate request ID for idempotency
    REQUEST_ID="things-sync-$(date +%s)-$$"
    
    # Send to Todoist
    sync_response=$(curl -s -X POST "${WORKER_URL}/things/sync" \
        -H "Content-Type: application/json" \
        -H "X-Request-Id: $REQUEST_ID" \
        -d "$things_tasks")
    
    if [ $? -ne 0 ]; then
        log "ERROR: Failed to sync tasks to Todoist"
        notify "Todoist-Things Sync" "Failed to sync tasks to Todoist"
    else
        # Parse response
        created=$(echo "$sync_response" | grep -o '"created":[0-9]*' | cut -d':' -f2)
        existing=$(echo "$sync_response" | grep -o '"existing":[0-9]*' | cut -d':' -f2)
        errors=$(echo "$sync_response" | grep -o '"errors":[0-9]*' | cut -d':' -f2)
        conflicts_detected=$(echo "$sync_response" | grep -o '"conflictsDetected":[0-9]*' | cut -d':' -f2)
        conflicts_resolved=$(echo "$sync_response" | grep -o '"conflictsResolved":[0-9]*' | cut -d':' -f2)
        
        log "Sync complete: Created: $created, Existing: $existing, Errors: $errors"
        
        if [ "$conflicts_detected" -gt 0 ] 2>/dev/null; then
            log "Conflicts: Detected: $conflicts_detected, Resolved: $conflicts_resolved"
            
            if [ "$conflicts_detected" -gt "$conflicts_resolved" ] 2>/dev/null; then
                notify "Sync Conflicts" "$((conflicts_detected - conflicts_resolved)) conflicts require manual resolution"
            fi
        fi
        
        # Tag synced tasks in Things
        if [ "$created" -gt 0 ] 2>/dev/null; then
            tag_result=$(run_applescript "${SCRIPT_DIR}/tag-things-synced.applescript" "$sync_response")
            log "Tagged $created tasks as synced in Things"
        fi
    fi
else
    log "No tasks in Things to sync"
fi

# STEP 3: Sync completed tasks
log "Step 3: Syncing completed tasks"

# Read completed tasks from Things
completed_tasks=$(run_applescript "${SCRIPT_DIR}/read-things-completed.applescript")

if [ $? -eq 0 ]; then
    completed_count=$(echo "$completed_tasks" | grep -o '"thingsId"' | wc -l | tr -d ' ')
    
    if [ "$completed_count" -gt 0 ]; then
        log "Found $completed_count completed tasks to sync"
        
        # Send to worker
        completed_response=$(curl -s -X POST "${WORKER_URL}/things/sync-completed" \
            -H "Content-Type: application/json" \
            -d "$completed_tasks")
        
        if [ $? -eq 0 ]; then
            completed_synced=$(echo "$completed_response" | grep -o '"completed":[0-9]*' | cut -d':' -f2)
            log "Marked $completed_synced tasks as completed in Todoist"
        else
            log "WARNING: Failed to sync completed tasks"
        fi
    else
        log "No completed tasks to sync"
    fi
else
    log "WARNING: Failed to read completed tasks from Things"
fi

# Final status
log "=== Sync completed successfully ==="

# Check for any unresolved conflicts
conflicts_check=$(curl -s "${WORKER_URL}/conflicts")
unresolved_count=$(echo "$conflicts_check" | grep -o '"count":[0-9]*' | cut -d':' -f2)

if [ "$unresolved_count" -gt 0 ] 2>/dev/null; then
    notify "Todoist-Things Sync" "Sync complete with $unresolved_count unresolved conflicts"
else
    notify "Todoist-Things Sync" "Sync completed successfully"
fi