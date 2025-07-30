#!/bin/bash

# Script to clean up Todoist and ensure it only has tasks that exist in Things
# This will remove any extra tasks in Todoist that aren't in Things

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================"
echo "Todoist Cleanup - Sync with Things"
echo "======================================"
echo ""
echo "⚠️  WARNING: This will DELETE tasks from Todoist that aren't in Things!"
echo ""

read -p "Are you sure you want to continue? (yes/no) " -r
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""

# 1. Get all tasks from Things
echo "1. Reading all tasks from Things inbox..."
things_tasks=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)

if [ $? -ne 0 ]; then
    echo "   ✗ Failed to read Things tasks"
    exit 1
fi

things_count=$(echo "$things_tasks" | grep -o '"id"' | wc -l | tr -d ' ')
echo "   ✓ Found $things_count tasks in Things"

# Extract Things task IDs
things_ids=$(echo "$things_tasks" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)

echo ""

# 2. Get all tasks from Todoist (including synced ones)
echo "2. Reading all tasks from Todoist inbox..."
todoist_response=$(curl -s "${WORKER_URL}/inbox?include_all=true")

if [ $? -ne 0 ]; then
    echo "   ✗ Failed to read Todoist tasks"
    exit 1
fi

# Parse Todoist response to get task details
echo "$todoist_response" > /tmp/todoist_tasks.json

# Count tasks
todoist_count=$(echo "$todoist_response" | grep -o '"id"' | wc -l | tr -d ' ')
echo "   ✓ Found $todoist_count tasks in Todoist"

echo ""

# 3. Check KV mappings to identify tasks to keep/delete
echo "3. Analyzing task mappings..."

tasks_to_delete=()
tasks_to_keep=()

# Parse each Todoist task
while IFS= read -r line; do
    if [[ $line =~ \"id\":\"([^\"]+)\" ]]; then
        todoist_id="${BASH_REMATCH[1]}"
        
        # Check if this task has a Things ID in notes
        task_line=$(echo "$todoist_response" | grep -o "{[^}]*\"id\":\"$todoist_id\"[^}]*}")
        
        # Extract Things ID from notes if present
        if [[ $task_line =~ \[things-id:([^\]]+)\] ]]; then
            things_id_in_notes="${BASH_REMATCH[1]}"
            
            # Check if this Things ID exists in current Things tasks
            if echo "$things_ids" | grep -q "^$things_id_in_notes$"; then
                tasks_to_keep+=("$todoist_id")
            else
                tasks_to_delete+=("$todoist_id")
            fi
        else
            # No Things ID found, this is either a native Todoist task or lost mapping
            tasks_to_delete+=("$todoist_id")
        fi
    fi
done <<< "$(echo "$todoist_response" | grep -o '"id":"[^"]*"')"

echo "   Tasks to keep: ${#tasks_to_keep[@]}"
echo "   Tasks to delete: ${#tasks_to_delete[@]}"

echo ""

# 4. Delete extra tasks from Todoist
if [ ${#tasks_to_delete[@]} -gt 0 ]; then
    echo "4. Deleting ${#tasks_to_delete[@]} extra tasks from Todoist..."
    
    deleted_count=0
    for task_id in "${tasks_to_delete[@]}"; do
        # Get task title for logging
        task_title=$(echo "$todoist_response" | grep -o "{[^}]*\"id\":\"$task_id\"[^}]*}" | grep -o '"title":"[^"]*"' | cut -d'"' -f4)
        
        echo -n "   Deleting: $task_title... "
        
        # Use the Todoist API directly to delete the task
        delete_response=$(curl -s -X DELETE \
            -H "Authorization: Bearer ${TODOIST_API_TOKEN}" \
            "https://api.todoist.com/rest/v2/tasks/$task_id")
        
        if [ $? -eq 0 ]; then
            echo "✓"
            ((deleted_count++))
        else
            echo "✗"
        fi
    done
    
    echo "   ✓ Deleted $deleted_count tasks"
else
    echo "4. No tasks to delete - Todoist is already in sync"
fi

echo ""

# 5. Run a fresh sync to ensure everything is aligned
echo "5. Running fresh sync to align both systems..."
"${SCRIPT_DIR}/sync-bidirectional.sh" > /tmp/cleanup_sync.log 2>&1

if [ $? -eq 0 ]; then
    echo "   ✓ Sync completed"
else
    echo "   ✗ Sync failed - check /tmp/cleanup_sync.log"
fi

echo ""

# 6. Final verification
echo "6. Final verification..."

# Re-read both systems
things_final=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)
things_final_count=$(echo "$things_final" | grep -o '"id"' | wc -l | tr -d ' ')

todoist_final=$(curl -s "${WORKER_URL}/inbox?include_all=true")
todoist_final_count=$(echo "$todoist_final" | grep -o '"title"' | wc -l | tr -d ' ')

echo "   Things: $things_final_count tasks"
echo "   Todoist: $todoist_final_count tasks"

if [ "$things_final_count" -eq "$todoist_final_count" ]; then
    echo "   ✓ Both systems are now in sync!"
else
    echo "   ⚠ Task counts still don't match"
    echo "   Run verify-sync-state.sh for detailed analysis"
fi

echo ""
echo "======================================"
echo "Cleanup complete"
echo "======================================"