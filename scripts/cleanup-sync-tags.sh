#!/bin/bash

# Script to clean up old sync tags from migrated tasks
# Removes 'synced-to-things' and 'synced-from-things' labels from tasks 
# that are already tracked by the fingerprint system

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-http://localhost:8787}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_color() {
    echo -e "${2}$(date '+%Y-%m-%d %H:%M:%S') - $1${NC}"
}

echo "🧹 Cleaning Up Sync Tags from Migrated Tasks"
echo "============================================="
echo

# Check if worker is running
log_color "Checking worker availability..." "$BLUE"
if ! curl -f -s "$WORKER_URL/health" > /dev/null; then
    log_color "❌ Worker not available at $WORKER_URL" "$RED"
    echo "Please start the worker with: npm run dev"
    exit 1
fi
log_color "✅ Worker is responding" "$GREEN"
echo

# Check current status before cleanup
log_color "📊 Checking current status..." "$BLUE"
status_response=$(curl -s "$WORKER_URL/sync/status")
if [ $? -ne 0 ]; then
    log_color "❌ Failed to get status" "$RED"
    exit 1
fi

tagged_tasks=$(echo "$status_response" | jq -r '.legacy.taggedTasks.total')
hash_mappings=$(echo "$status_response" | jq -r '.fingerprint.hashMappings')

log_color "📈 Current System State:" "$BLUE"
echo "   • Tasks with sync tags: $tagged_tasks"
echo "   • Fingerprint mappings: $hash_mappings"
echo

if [ "$tagged_tasks" = "0" ]; then
    log_color "✨ No tagged tasks found - system is already clean!" "$GREEN"
    exit 0
fi

if [ "$hash_mappings" = "0" ]; then
    log_color "⚠️  No fingerprint mappings found. Run migration first." "$YELLOW"
    echo "Use: ./scripts/migrate-to-fingerprint.sh"
    exit 1
fi

# Run tag cleanup
log_color "🧹 Starting tag cleanup process..." "$YELLOW"
cleanup_response=$(curl -s -X POST "$WORKER_URL/cleanup-tags")
cleanup_exit_code=$?

if [ $cleanup_exit_code -ne 0 ]; then
    log_color "❌ Cleanup request failed" "$RED"
    exit 1
fi

# Parse cleanup results
if echo "$cleanup_response" | jq -e '.error' > /dev/null; then
    log_color "❌ Cleanup failed:" "$RED"
    echo "$cleanup_response" | jq -r '.message'
    exit 1
fi

# Extract cleanup statistics
processed=$(echo "$cleanup_response" | jq -r '.processed')
cleaned=$(echo "$cleanup_response" | jq -r '.cleaned')
errors=$(echo "$cleanup_response" | jq -r '.errors')

log_color "✅ Tag cleanup completed successfully!" "$GREEN"
echo
log_color "📊 Cleanup Results:" "$BLUE"
echo "   🏷️  Tasks processed: $processed"
echo "   🧹 Tags cleaned: $cleaned"
echo "   ❌ Errors: $errors"
echo

# Show cleanup details if available
if echo "$cleanup_response" | jq -e '.summary[]' > /dev/null; then
    log_color "📝 Cleanup Details:" "$BLUE"
    echo "$cleanup_response" | jq -r '.summary[]' | head -10 | while read line; do
        echo "   • $line"
    done
    
    total_summary=$(echo "$cleanup_response" | jq -r '.summary | length')
    if [ "$total_summary" -gt 10 ]; then
        echo "   ... and $((total_summary - 10)) more items"
    fi
    echo
fi

# Check post-cleanup status
log_color "📊 Checking post-cleanup status..." "$BLUE"
sleep 2  # Give system time to settle
post_status_response=$(curl -s "$WORKER_URL/sync/status")

if [ $? -eq 0 ]; then
    post_tagged_tasks=$(echo "$post_status_response" | jq -r '.legacy.taggedTasks.total')
    
    log_color "📈 Post-cleanup Summary:" "$BLUE"
    echo "   • Tasks with sync tags: $post_tagged_tasks (was $tagged_tasks)"
    echo "   • Reduction: $((tagged_tasks - post_tagged_tasks)) tasks cleaned"
    echo
    
    if [ "$post_tagged_tasks" = "0" ]; then
        log_color "🎉 All sync tags cleaned! UI is now completely tag-free." "$GREEN"
    else
        log_color "⚠️  Some tagged tasks remain. They may not be migrated yet." "$YELLOW"
        echo "   Run migration first: ./scripts/migrate-to-fingerprint.sh"
    fi
else
    log_color "⚠️  Could not get post-cleanup status" "$YELLOW"
fi

echo
log_color "📄 Cleanup details saved to /tmp/cleanup_response.json" "$BLUE"
echo "$cleanup_response" | jq '.' > /tmp/cleanup_response.json

echo
echo "🧹 Tag cleanup script completed!"
echo "Your tasks should now be free of sync label clutter."
