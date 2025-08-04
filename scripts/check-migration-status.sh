#!/bin/bash

# Status checking script for fingerprint-based sync system
# Shows detailed information about migration progress and system state

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

print_status() {
    if [ "$2" = "true" ] || [ "$2" = "0" ]; then
        echo -e "✅ ${GREEN}$1${NC}"
    elif [ "$2" = "false" ] || [ "$2" != "0" ]; then
        echo -e "❌ ${RED}$1${NC}"
    else
        echo -e "ℹ️  ${BLUE}$1${NC}"
    fi
}

print_warning() {
    echo -e "⚠️  ${YELLOW}$1${NC}"
}

print_info() {
    echo -e "ℹ️  ${BLUE}$1${NC}"
}

# Check if worker is running
echo
print_header "🔍 Fingerprint Sync System Status Check"
echo

print_info "Checking worker availability..."
if ! curl -f -s "$WORKER_URL/health" > /dev/null; then
    echo -e "❌ ${RED}Worker not available at $WORKER_URL${NC}"
    echo "Please start the worker with: npm run dev"
    exit 1
fi
print_status "Worker is responding" "true"
echo

# Get system status
print_info "Fetching system status..."
status_response=$(curl -s "$WORKER_URL/sync/status")
if [ $? -ne 0 ]; then
    echo -e "❌ ${RED}Failed to get status${NC}"
    exit 1
fi

# Parse status response
sync_locked=$(echo "$status_response" | jq -r '.syncLocked')
legacy_total=$(echo "$status_response" | jq -r '.legacy.mappings.total')
legacy_things=$(echo "$status_response" | jq -r '.legacy.mappings.things')
legacy_todoist=$(echo "$status_response" | jq -r '.legacy.mappings.todoist')

tagged_total=$(echo "$status_response" | jq -r '.legacy.taggedTasks.total')
tagged_with_fingerprints=$(echo "$status_response" | jq -r '.legacy.taggedTasks.withFingerprints')
tagged_pending=$(echo "$status_response" | jq -r '.legacy.taggedTasks.pendingMigration')

hash_mappings=$(echo "$status_response" | jq -r '.fingerprint.hashMappings')
migrated_legacy=$(echo "$status_response" | jq -r '.fingerprint.migratedLegacyMappings')
pending_legacy=$(echo "$status_response" | jq -r '.fingerprint.pendingLegacyMigration')

migration_progress=$(echo "$status_response" | jq -r '.migration.progress')
migration_complete=$(echo "$status_response" | jq -r '.migration.isComplete')

echo
print_header "📊 System Overview"
print_status "Sync locked: $sync_locked" "$sync_locked"
print_status "Migration complete: $migration_complete" "$migration_complete"
print_info "Migration progress: $migration_progress"

echo
print_header "🏷️ Legacy Tag-Based System"
echo "📂 Legacy Mappings:"
echo "   • Total mappings: $legacy_total"
echo "   • Things mappings: $legacy_things"
echo "   • Todoist mappings: $legacy_todoist"
echo "   • Migrated to fingerprint: $migrated_legacy"
echo "   • Pending migration: $pending_legacy"

echo
echo "🏷️ Tagged Tasks in Todoist:"
echo "   • Total tagged tasks: $tagged_total"
echo "   • With fingerprints: $tagged_with_fingerprints"
echo "   • Pending migration: $tagged_pending"

echo
print_header "🔍 Fingerprint-Based System"
echo "🗂️ Hash Mappings: $hash_mappings"

if [ "$hash_mappings" -gt 0 ]; then
    print_status "Fingerprint system active" "true"
else
    print_warning "No fingerprint mappings found"
fi

echo
print_header "🎯 Migration Status"

if [ "$migration_complete" = "true" ]; then
    print_status "Migration fully complete!" "true"
    print_info "System is ready for tag-free operation"
else
    print_warning "Migration incomplete"
    
    # Show recommendations
    recommendations=$(echo "$status_response" | jq -r '.migration.recommendations[]' 2>/dev/null)
    if [ ! -z "$recommendations" ]; then
        echo
        print_info "Recommendations:"
        echo "$recommendations" | while read rec; do
            echo "   • $rec"
        done
    fi
fi

echo
print_header "📈 Detailed Statistics"

# Create a summary table
echo "┌─────────────────────────────┬──────────┐"
echo "│ Metric                      │ Count    │"
echo "├─────────────────────────────┼──────────┤"
printf "│ %-27s │ %8s │\n" "Legacy mappings" "$legacy_total"
printf "│ %-27s │ %8s │\n" "Hash-based mappings" "$hash_mappings"
printf "│ %-27s │ %8s │\n" "Tagged tasks (total)" "$tagged_total"
printf "│ %-27s │ %8s │\n" "Tagged tasks (migrated)" "$tagged_with_fingerprints"
printf "│ %-27s │ %8s │\n" "Legacy pending migration" "$pending_legacy"
printf "│ %-27s │ %8s │\n" "Tagged pending migration" "$tagged_pending"
echo "└─────────────────────────────┴──────────┘"

echo
print_header "🔧 Available Actions"

if [ "$migration_complete" = "false" ]; then
    echo "🚀 To run migration:"
    echo "   curl -X POST $WORKER_URL/migrate"
    echo "   or: ./scripts/migrate-to-fingerprint.sh"
    echo
fi

echo "📊 To check status again:"
echo "   curl $WORKER_URL/sync/status | jq"
echo "   or: ./scripts/check-migration-status.sh"

echo
echo "🔍 To test fingerprint system:"
echo "   curl $WORKER_URL/inbox"
echo "   curl $WORKER_URL/inbox?include_all=true"

echo
echo "💾 Raw status data saved to /tmp/sync_status.json"
echo "$status_response" | jq '.' > /tmp/sync_status.json

echo
print_info "Status check completed at $(date)"
