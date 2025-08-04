#!/bin/bash

# Script to debug duplicate detection issues between Todoist and Things
# Analyzes fingerprints, mappings, and identifies potential duplicates

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-http://localhost:8787}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_header() {
    echo -e "${CYAN}$1${NC}"
    echo "$(echo "$1" | sed 's/./=/g')"
}

print_info() {
    echo -e "ℹ️  ${BLUE}$1${NC}"
}

print_warning() {
    echo -e "⚠️  ${YELLOW}$1${NC}"
}

print_error() {
    echo -e "❌ ${RED}$1${NC}"
}

print_success() {
    echo -e "✅ ${GREEN}$1${NC}"
}

echo
print_header "🔍 Duplicate Detection Debug Analysis"
echo

# Check worker availability
print_info "Checking worker availability..."
if ! curl -f -s "$WORKER_URL/health" > /dev/null; then
    print_error "Worker not available at $WORKER_URL"
    echo "Please start the worker with: npm run dev"
    exit 1
fi
print_success "Worker is responding"
echo

# Get Todoist inbox tasks (all)
print_header "📱 Todoist Tasks Analysis"
print_info "Fetching all Todoist inbox tasks..."

todoist_all=$(curl -s "$WORKER_URL/inbox?include_all=true")
todoist_unsynced=$(curl -s "$WORKER_URL/inbox")

if [ $? -ne 0 ]; then
    print_error "Failed to fetch Todoist tasks"
    exit 1
fi

todoist_all_count=$(echo "$todoist_all" | jq length)
todoist_unsynced_count=$(echo "$todoist_unsynced" | jq length)

echo "📊 Todoist Task Counts:"
echo "   • Total tasks: $todoist_all_count"
echo "   • Unsynced tasks: $todoist_unsynced_count"
echo "   • Synced tasks: $((todoist_all_count - todoist_unsynced_count))"
echo

echo "📝 All Todoist Tasks:"
echo "$todoist_all" | jq -r '.[] | "   • \(.attributes.title) (tags: \(.attributes.tags // [] | join(", ") | if . == "" then "none" else . end))"'
echo

echo "🆕 Unsynced Todoist Tasks:"
if [ "$todoist_unsynced_count" -gt 0 ]; then
    echo "$todoist_unsynced" | jq -r '.[] | "   • \(.attributes.title)"'
else
    echo "   (No unsynced tasks - all are marked as synced)"
fi
echo

# Get system status
print_header "💾 Fingerprint System Analysis"
print_info "Fetching system status..."

status_response=$(curl -s "$WORKER_URL/sync/status")
if [ $? -ne 0 ]; then
    print_error "Failed to get system status"
    exit 1
fi

hash_mappings=$(echo "$status_response" | jq -r '.fingerprint.hashMappings')
legacy_mappings=$(echo "$status_response" | jq -r '.legacy.mappings.total')
tagged_tasks=$(echo "$status_response" | jq -r '.legacy.taggedTasks.total')

echo "📊 System Status:"
echo "   • Hash-based mappings: $hash_mappings"
echo "   • Legacy mappings: $legacy_mappings" 
echo "   • Tagged tasks: $tagged_tasks"
echo

# Check for potential Issues
print_header "🕵️ Potential Issues Analysis"

# Issue 1: Tasks marked as synced but not in fingerprint system
if [ "$todoist_unsynced_count" -eq 0 ] && [ "$hash_mappings" -lt "$todoist_all_count" ]; then
    print_warning "Issue detected: All tasks marked as synced but fewer fingerprint mappings"
    echo "   This suggests tasks were synced before fingerprint migration"
    echo "   Recommendation: Re-run migration to create proper fingerprints"
    echo
fi

# Issue 2: More hash mappings than tasks
if [ "$hash_mappings" -gt "$todoist_all_count" ]; then
    print_warning "Issue detected: More fingerprint mappings than Todoist tasks"
    echo "   This could indicate:"
    echo "   • Deleted tasks still have mappings"
    echo "   • Multiple mappings per task"
    echo "   • Test tasks that were removed"
    echo
fi

# Issue 3: Tasks with sync tags but not in fingerprint system
if [ "$tagged_tasks" -gt 0 ]; then
    print_warning "Issue detected: Tasks still have sync tags"
    echo "   Recommendation: Run tag cleanup script"
    echo
fi

print_header "🔧 Diagnostic Recommendations"

echo "1. 📋 Check Things app manually:"
echo "   • Count tasks in Things inbox"
echo "   • Look for tasks with similar titles"
echo "   • Check if tasks have 'synced-from-todoist' tags"
echo

echo "2. 🧪 Test deduplication:"
echo "   • Try syncing a task that exists in both systems"
echo "   • Check if it gets detected as duplicate"
echo

echo "3. 🔄 If duplicates exist in Things:"
echo "   • Run: ./scripts/find-duplicates-things.applescript"
echo "   • Manually remove duplicates in Things"
echo "   • Re-sync to test deduplication"
echo

echo "4. 🛠️ Force re-sync test:"
echo "   • Clear all fingerprint mappings (CAUTION)"
echo "   • Re-run migration"
echo "   • Test if deduplication works correctly"
echo

# Save detailed analysis
echo "💾 Saving detailed data for analysis..."
echo "$todoist_all" > /tmp/todoist_all_tasks.json
echo "$todoist_unsynced" > /tmp/todoist_unsynced_tasks.json
echo "$status_response" > /tmp/system_status.json

print_success "Analysis complete!"
echo "Detailed data saved to /tmp/*tasks.json and /tmp/system_status.json"
echo

# Generate fingerprint analysis for each task
print_header "🔍 Task Fingerprint Analysis"
echo "$todoist_all" | jq -r '.[] | @base64' | while IFS= read -r task_data; do
    task=$(echo "$task_data" | base64 --decode)
    title=$(echo "$task" | jq -r '.attributes.title')
    notes=$(echo "$task" | jq -r '.attributes.notes // ""')
    
    echo "📋 Task: $title"
    echo "   Notes: $(echo "$notes" | head -c 50)$([ ${#notes} -gt 50 ] && echo "...")"
    
    # We can't generate fingerprints here without the crypto functions,
    # but we can show the content that would be fingerprinted
    echo "   Content length: ${#title} chars"
    echo "   Notes length: ${#notes} chars"
    echo
done
