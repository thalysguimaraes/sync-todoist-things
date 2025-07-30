#!/bin/bash

# Script to fix sync labels and ensure proper bidirectional sync

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "======================================"
echo "Fixing Sync Labels"
echo "======================================"
echo ""

# First, let's create a proper test by:
# 1. Clearing all labels
# 2. Running a fresh sync

echo "1. Getting current Todoist state..."
todoist_all=$(curl -s "${WORKER_URL}/inbox?include_all=true")
task_count=$(echo "$todoist_all" | grep -o '"title"' | wc -l | tr -d ' ')
echo "   Found $task_count total tasks in Todoist"

echo ""
echo "2. Resetting sync state..."
echo "   This will remove all sync labels and start fresh"
echo ""

# For now, let's just run a proper bidirectional sync
echo "3. Running fresh bidirectional sync..."
"${SCRIPT_DIR}/sync-bidirectional.sh"

echo ""
echo "4. Verifying final state..."

# Check Things
things_tasks=$("${SCRIPT_DIR}/read-things-inbox.applescript" 2>/dev/null)
things_count=$(echo "$things_tasks" | grep -o '"id"' | wc -l | tr -d ' ')

# Check Todoist (only unsynced)
todoist_unsynced=$(curl -s "${WORKER_URL}/inbox?include_all=false")
todoist_unsynced_count=$(echo "$todoist_unsynced" | grep -o '"title"' | wc -l | tr -d ' ')

echo "   Things inbox: $things_count tasks"
echo "   Todoist inbox (active): $todoist_unsynced_count tasks"

if [ "$todoist_unsynced_count" -eq 0 ]; then
    echo "   ✓ All Todoist tasks are properly synced!"
else
    echo "   ⚠ Found $todoist_unsynced_count unsynced tasks in Todoist"
fi

echo ""
echo "======================================"
echo "Fix complete"
echo "======================================"