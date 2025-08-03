#!/bin/bash

# Enhanced test script for completion sync debugging
# This script helps test and debug the completion sync issues

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Testing Completion Sync ==="
echo "Worker URL: $WORKER_URL"
echo

# Step 1: Check current sync status
echo "1. Checking sync status..."
curl -s "${WORKER_URL}/sync/status" | python3 -m json.tool || echo "Failed to get status"
echo

# Step 2: Read completed tasks from Things
echo "2. Reading completed tasks from Things..."
completed_tasks=$("${SCRIPT_DIR}/read-things-completed.applescript" 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$completed_tasks" ] || [ "$completed_tasks" = "[]" ]; then
    echo "No completed tasks found or error reading from Things"
    echo "Completed tasks output: $completed_tasks"
else
    echo "Found completed tasks:"
    echo "$completed_tasks" | python3 -m json.tool 2>/dev/null || echo "$completed_tasks"
    
    # Count completed tasks
    completed_count=$(echo "$completed_tasks" | grep -o '"thingsId"' | wc -l | tr -d ' ')
    echo "Total completed tasks: $completed_count"
    echo
    
    # Step 3: Test sync
    echo "3. Testing completion sync to Todoist..."
    completion_response=$(curl -s -X POST "${WORKER_URL}/things/sync-completed" \
        -H "Content-Type: application/json" \
        -d "$completed_tasks")
    
    if [ $? -eq 0 ]; then
        echo "Sync response:"
        echo "$completion_response" | python3 -m json.tool 2>/dev/null || echo "$completion_response"
        
        # Extract summary
        completed=$(echo "$completion_response" | grep -o '"summary":{[^}]*"completed":[0-9]*' | grep -o '"completed":[0-9]*' | cut -d':' -f2)
        not_found=$(echo "$completion_response" | grep -o '"summary":{[^}]*"notFound":[0-9]*' | grep -o '"notFound":[0-9]*' | cut -d':' -f2)
        errors=$(echo "$completion_response" | grep -o '"summary":{[^}]*"errors":[0-9]*' | grep -o '"errors":[0-9]*' | cut -d':' -f2)
        
        echo
        echo "=== Summary ==="
        echo "Completed: $completed"
        echo "Not Found: $not_found"
        echo "Errors: $errors"
        
        if [ "$not_found" -gt 0 ] 2>/dev/null; then
            echo
            echo "=== Debugging Not Found Items ==="
            echo "Items not found in Todoist mapping - checking for orphaned tasks..."
            
            # Show details of not found items
            echo "$completion_response" | grep -o '"results":\[[^]]*\]' | sed 's/"results"://' | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for item in data:
        if item.get('status') == 'not_found':
            print(f\"Things ID: {item['thingsId']} - {item.get('message', 'No message')}\")
except: pass
" 2>/dev/null
        fi
        
    else
        echo "ERROR: Failed to sync completed tasks"
    fi
fi

echo
echo "=== Manual Verification Steps ==="
echo "1. Check Things logbook for tasks with 'synced-from-todoist' or 'synced-to-todoist' tags"
echo "2. Verify corresponding tasks exist in Todoist inbox"
echo "3. Check KV store mappings via: curl ${WORKER_URL}/sync/status"
echo "4. Look for [things-id:xxx] in Todoist task descriptions"
