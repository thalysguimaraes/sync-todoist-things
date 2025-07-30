#!/bin/bash

# Script to clean up Todoist via Worker API
# Ensures Todoist only has tasks that exist in Things

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================"
echo "Todoist Cleanup - Sync with Things"
echo "======================================"
echo ""
echo "This will ensure Todoist only contains tasks that exist in Things."
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

# Show Things tasks
echo "   Things tasks:"
echo "$things_tasks" | perl -pe 's/},{/},\n{/g' | grep -o '"title":"[^"]*"' | sed 's/"title":"//; s/"$//' | while read -r title; do
    echo "     - $title"
done

echo ""

# 2. Clear all tasks in Todoist inbox using the Worker API
echo "2. Clearing all tasks from Todoist inbox..."
echo "   (Tasks will be labeled as 'synced-to-things', not deleted)"

clear_response=$(curl -s -X POST "${WORKER_URL}/inbox/clear?mode=label")

if [ $? -eq 0 ]; then
    cleared_count=$(echo "$clear_response" | grep -o '"status":"labeled"' | wc -l | tr -d ' ')
    echo "   ✓ Cleared $cleared_count tasks from Todoist"
else
    echo "   ✗ Failed to clear Todoist tasks"
    exit 1
fi

echo ""

# 3. Run a fresh sync from Things to Todoist
echo "3. Syncing tasks from Things to Todoist..."

# First, make sure Things tasks are properly read
if [ "$things_count" -gt 0 ] && [ "$things_tasks" != "[]" ]; then
    # Send Things tasks to Todoist
    sync_response=$(curl -s -X POST "${WORKER_URL}/things/sync" \
        -H "Content-Type: application/json" \
        -d "$things_tasks")
    
    if [ $? -eq 0 ]; then
        created=$(echo "$sync_response" | grep -o '"summary":{[^}]*"created":[0-9]*' | grep -o '"created":[0-9]*' | cut -d':' -f2)
        existing=$(echo "$sync_response" | grep -o '"summary":{[^}]*"existing":[0-9]*' | grep -o '"existing":[0-9]*' | cut -d':' -f2)
        
        echo "   ✓ Sync complete: $created created, $existing already existed"
    else
        echo "   ✗ Failed to sync tasks"
        exit 1
    fi
else
    echo "   No tasks to sync from Things"
fi

echo ""

# 4. Final verification
echo "4. Final verification..."

# Re-read both systems
todoist_final=$(curl -s "${WORKER_URL}/inbox?include_all=false")
todoist_final_count=$(echo "$todoist_final" | grep -o '"title"' | wc -l | tr -d ' ')

echo "   Things: $things_count tasks"
echo "   Todoist (active): $todoist_final_count tasks"

if [ "$things_count" -eq "$todoist_final_count" ]; then
    echo "   ✓ Both systems are now in sync!"
    
    echo ""
    echo "   Final task list:"
    echo "$todoist_final" | perl -pe 's/},{/},\n{/g' | grep -o '"title":"[^"]*"' | sed 's/"title":"//; s/"$//' | while read -r title; do
        echo "     - $title"
    done
else
    echo "   ⚠ Task counts still don't match"
    echo "   This might be because some tasks are still being processed"
fi

echo ""
echo "======================================"
echo "Cleanup complete"
echo "======================================"
echo ""
echo "Note: Old tasks in Todoist have been labeled 'synced-to-things'"
echo "rather than deleted. You can find them in Todoist with that label."