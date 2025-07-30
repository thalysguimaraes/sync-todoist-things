#!/bin/bash

# Script to verify sync state between Things and Todoist
# Ensures both systems have the same tasks

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================"
echo "Sync State Verification"
echo "======================================"
echo ""

# 1. Get current state from Things
echo "1. Reading current Things inbox tasks..."
things_tasks=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)

if [ $? -eq 0 ]; then
    things_count=$(echo "$things_tasks" | grep -o '"id"' | wc -l | tr -d ' ')
    echo "   ✓ Found $things_count tasks in Things inbox"
    
    if [ "$things_count" -gt 0 ] && [ "$things_tasks" != "[]" ]; then
        echo "   Things tasks:"
        echo "$things_tasks" | perl -pe 's/},{/},\n{/g' | grep -o '"title":"[^"]*"' | sed 's/"title":"//; s/"$//' | while read -r title; do
            echo "     - $title"
        done
    fi
else
    echo "   ✗ Failed to read Things tasks"
    exit 1
fi

echo ""

# 2. Get current state from Todoist
echo "2. Reading current Todoist inbox tasks..."
todoist_response=$(curl -s "${WORKER_URL}/inbox?include_all=true")

if [ $? -eq 0 ]; then
    todoist_count=$(echo "$todoist_response" | grep -o '"title"' | wc -l | tr -d ' ')
    echo "   ✓ Found $todoist_count tasks in Todoist inbox"
    
    if [ "$todoist_count" -gt 0 ]; then
        echo "   Todoist tasks:"
        echo "$todoist_response" | perl -pe 's/},{/},\n{/g' | grep -o '"title":"[^"]*"' | sed 's/"title":"//; s/"$//' | while read -r title; do
            echo "     - $title"
        done
    fi
else
    echo "   ✗ Failed to read Todoist tasks"
    exit 1
fi

echo ""

# 3. Check sync status
echo "3. Checking sync metadata..."
sync_status=$(curl -s "${WORKER_URL}/sync/status")

if [ $? -eq 0 ]; then
    mappings_total=$(echo "$sync_status" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    echo "   ✓ Found $mappings_total task mappings in KV store"
else
    echo "   ✗ Failed to check sync status"
fi

echo ""

# 4. Run a full sync
echo "4. Running full bidirectional sync..."
sync_output=$("${SCRIPT_DIR}/sync-bidirectional.sh" 2>&1)

if [ $? -eq 0 ]; then
    echo "   ✓ Sync completed successfully"
    
    # Extract summary from logs
    if echo "$sync_output" | grep -q "Syncing from Todoist"; then
        todoist_to_things=$(echo "$sync_output" | grep "Found.*new tasks in Todoist" | tail -1)
        [ -n "$todoist_to_things" ] && echo "   $todoist_to_things"
    fi
    
    if echo "$sync_output" | grep -q "Syncing from Things"; then
        things_to_todoist=$(echo "$sync_output" | grep "Things → Todoist:" | tail -1)
        [ -n "$things_to_todoist" ] && echo "   $things_to_todoist"
    fi
    
    if echo "$sync_output" | grep -q "Syncing completed tasks"; then
        completed_sync=$(echo "$sync_output" | grep "Completed tasks sync:" | tail -1)
        [ -n "$completed_sync" ] && echo "   $completed_sync"
    fi
else
    echo "   ✗ Sync failed"
    echo "   Error output:"
    echo "$sync_output" | tail -10
fi

echo ""

# 5. Verify final state
echo "5. Verifying final state after sync..."

# Re-read Things
things_tasks_after=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)
things_count_after=$(echo "$things_tasks_after" | grep -o '"id"' | wc -l | tr -d ' ')

# Re-read Todoist
todoist_response_after=$(curl -s "${WORKER_URL}/inbox?include_all=true")
todoist_count_after=$(echo "$todoist_response_after" | grep -o '"title"' | wc -l | tr -d ' ')

echo "   Things: $things_count_after tasks"
echo "   Todoist: $todoist_count_after tasks"

if [ "$things_count_after" -eq "$todoist_count_after" ]; then
    echo "   ✓ Task counts match!"
else
    echo "   ⚠ Task counts don't match"
    echo "   This might be due to:"
    echo "   - Tasks already marked with 'synced' labels"
    echo "   - Completed tasks not yet synced"
    echo "   - Tasks in different projects/lists"
fi

echo ""
echo "======================================"
echo "Verification complete"
echo "======================================"

# Optional: Show detailed task comparison
echo ""
read -p "Show detailed task comparison? (y/n) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "Detailed Comparison:"
    echo "-------------------"
    
    # Create temp files for comparison
    echo "$things_tasks_after" | perl -pe 's/},{/},\n{/g' | grep -o '"title":"[^"]*"' | sed 's/"title":"//; s/"$//' | sort > /tmp/things_titles.txt
    echo "$todoist_response_after" | perl -pe 's/},{/},\n{/g' | grep -o '"title":"[^"]*"' | sed 's/"title":"//; s/"$//' | sort > /tmp/todoist_titles.txt
    
    echo ""
    echo "Tasks only in Things:"
    comm -23 /tmp/things_titles.txt /tmp/todoist_titles.txt | sed 's/^/  - /'
    
    echo ""
    echo "Tasks only in Todoist:"
    comm -13 /tmp/things_titles.txt /tmp/todoist_titles.txt | sed 's/^/  - /'
    
    echo ""
    echo "Tasks in both:"
    comm -12 /tmp/things_titles.txt /tmp/todoist_titles.txt | sed 's/^/  - /'
    
    # Cleanup
    rm -f /tmp/things_titles.txt /tmp/todoist_titles.txt
fi