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

# Start bidirectional sync
log "Starting bidirectional sync..."

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
    
    # Open in Things
    open "$todoist_url"
    sleep 3  # Give Things time to create the tasks
    
    # Mark as synced in Todoist
    curl -s -X POST "${WORKER_URL}/inbox/mark-synced" > /dev/null
    log "Marked $todoist_count tasks as synced in Todoist"
    
    # Tag tasks in Things if we have mappings
    if [ -n "$todoist_mappings" ] && [ "$todoist_mappings" != "[]" ]; then
        log "Tagging imported tasks in Things with existing Todoist IDs"
        "${SCRIPT_DIR}/tag-things-synced.applescript" "$todoist_mappings" 2>&1 | while read line; do
            log "Things tagging: $line"
        done
    fi
else
    log "No new tasks in Todoist to sync"
fi

# STEP 2: Sync from Things to Todoist
log "Step 2: Syncing from Things → Todoist"

# Read tasks from Things inbox using AppleScript
things_tasks=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)

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
        created=$(echo "$sync_response" | grep -o '"created":[0-9]*' | cut -d':' -f2)
        existing=$(echo "$sync_response" | grep -o '"existing":[0-9]*' | cut -d':' -f2)
        errors=$(echo "$sync_response" | grep -o '"errors":[0-9]*' | cut -d':' -f2)
        
        log "Things → Todoist: $created created, $existing already existed, $errors errors"
        
        # Tag synced tasks in Things
        if [ "$created" -gt 0 ] 2>/dev/null; then
            # Extract successful mappings from the response
            task_mappings=$(echo "$sync_response" | 
                grep -o '"id":"[^"]*","title":"[^"]*","status":"created","todoist_id":"[^"]*"' | 
                sed 's/"id":"/\{"thingsId":"/g' | 
                sed 's/","title":"[^"]*","status":"created","todoist_id":"/","todoistId":"/g' | 
                sed 's/$/\}/g' | 
                tr '\n' ',' | 
                sed 's/,$//' | 
                sed 's/^/[/' | 
                sed 's/$/]/')
            
            if [ -n "$task_mappings" ] && [ "$task_mappings" != "[]" ]; then
                log "Tagging $created newly synced tasks in Things"
                tag_result=$("${SCRIPT_DIR}/tag-things-synced.applescript" "$task_mappings" 2>&1)
                log "Things tagging result: $tag_result"
            fi
        fi
    else
        log "ERROR: Failed to sync tasks from Things to Todoist"
    fi
fi

log "Bidirectional sync completed"

# Summary
echo "Sync completed at $(date '+%Y-%m-%d %H:%M:%S')"
echo "Check logs at: $LOG_FILE"