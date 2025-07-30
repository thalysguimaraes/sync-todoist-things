#!/bin/bash

# Test script to verify completion sync functionality

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"

echo "Testing completion sync functionality..."
echo "=================================="

# Test 1: Check if the new endpoint is accessible
echo -n "1. Testing /things/sync-completed endpoint... "
response=$(curl -s -X POST "${WORKER_URL}/things/sync-completed" \
    -H "Content-Type: application/json" \
    -d '[]' \
    -w "\n%{http_code}")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | head -n-1)

if [ "$http_code" = "200" ]; then
    echo "✓ OK"
else
    echo "✗ Failed (HTTP $http_code)"
    echo "Response: $body"
fi

# Test 2: Read completed tasks from Things
echo -n "2. Reading completed tasks from Things... "
completed_tasks=$(./read-things-completed.applescript 2>&1)

if [ $? -eq 0 ]; then
    count=$(echo "$completed_tasks" | grep -o '"thingsId"' | wc -l | tr -d ' ')
    echo "✓ Found $count completed tasks"
    
    # Show first task if any
    if [ "$count" -gt 0 ] && [ "$completed_tasks" != "[]" ]; then
        echo "   Sample data: ${completed_tasks:0:100}..."
    fi
else
    echo "✗ Failed"
    echo "Error: $completed_tasks"
fi

# Test 3: Test full sync
echo -n "3. Testing full bidirectional sync... "
./sync-bidirectional.sh > /tmp/sync-test.log 2>&1

if [ $? -eq 0 ]; then
    echo "✓ Success"
    
    # Check log for completion sync
    if grep -q "Syncing completed tasks" /tmp/sync-test.log; then
        echo "   ✓ Completion sync step executed"
        
        # Extract results
        completed_line=$(grep "Completed tasks sync:" /tmp/sync-test.log | tail -1)
        if [ -n "$completed_line" ]; then
            echo "   $completed_line"
        fi
    else
        echo "   ⚠ Completion sync step not found in log"
    fi
else
    echo "✗ Failed"
    echo "Check /tmp/sync-test.log for details"
fi

echo ""
echo "=================================="
echo "Test completed. Check logs for details."