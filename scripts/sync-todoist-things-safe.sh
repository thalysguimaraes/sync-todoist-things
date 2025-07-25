#!/bin/bash

# Todoist to Things Sync Script (Safe Mode - No Deletion)
# This script fetches tasks from Todoist inbox and imports them into Things
# It marks tasks as synced using labels to avoid duplicates

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://your-worker.workers.dev}"
LOG_FILE="$HOME/Library/Logs/todoist-things-sync.log"

# Function to log messages
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Start sync
log "Starting sync (safe mode)..."

# Fetch only unsynced tasks from Cloudflare Worker
response=$(curl -s "${WORKER_URL}/inbox?format=url")

if [ $? -ne 0 ]; then
    log "ERROR: Failed to fetch tasks from worker"
    exit 1
fi

# Extract Things URL and task count from response
things_url=$(echo "$response" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
task_count=$(echo "$response" | grep -o '"count":[0-9]*' | cut -d':' -f2)
filtered=$(echo "$response" | grep -o '"filtered":[^,}]*' | cut -d':' -f2)

if [ -z "$things_url" ]; then
    log "ERROR: No Things URL in response"
    exit 1
fi

# Check if there are tasks to sync
if [ "$task_count" -eq 0 ] || [ "$task_count" == "0" ]; then
    log "No new tasks to sync (filtered: $filtered)"
    exit 0
fi

log "Found $task_count new tasks to sync"

# Open Things URL
open "$things_url"

# Wait a moment for Things to process
sleep 2

# Mark tasks as synced (using labels, not deleting)
mark_response=$(curl -s -X POST "${WORKER_URL}/inbox/mark-synced")

if [ $? -eq 0 ]; then
    marked_count=$(echo "$mark_response" | grep -o '"count":[0-9]*' | cut -d':' -f2)
    log "Successfully marked $marked_count tasks as synced in Todoist"
else
    log "WARNING: Failed to mark tasks as synced - may result in duplicates next time"
fi

log "Sync completed (safe mode)"