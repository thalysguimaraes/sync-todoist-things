#!/bin/bash

# Migration script for converting tag-based sync to fingerprint-based sync
# This script migrates existing tagged tasks and KV mappings to the new system

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Configuration
WORKER_URL="${TODOIST_THINGS_WORKER_URL:-http://localhost:8787}"
LOG_FILE="$HOME/Library/Logs/fingerprint-migration.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

log_color() {
    echo -e "${2}$(date '+%Y-%m-%d %H:%M:%S') - $1${NC}" | tee -a "$LOG_FILE"
}

echo "🔄 Starting Migration to Fingerprint-Based Sync System"
echo "======================================================="
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

# Get pre-migration status
log_color "📊 Getting pre-migration status..." "$BLUE"
status_response=$(curl -s "$WORKER_URL/sync/status")
if [ $? -ne 0 ]; then
    log_color "❌ Failed to get status" "$RED"
    exit 1
fi

echo "$status_response" | jq '.' > /tmp/pre_migration_status.json
legacy_mappings=$(echo "$status_response" | jq -r '.legacy.mappings.total')
tagged_tasks=$(echo "$status_response" | jq -r '.legacy.taggedTasks.total')
pending_migration=$(echo "$status_response" | jq -r '.legacy.taggedTasks.pendingMigration')

log_color "📈 Pre-migration Summary:" "$BLUE"
echo "   • Legacy mappings: $legacy_mappings"
echo "   • Tagged tasks: $tagged_tasks"
echo "   • Tasks pending migration: $pending_migration"
echo

# Run migration
log_color "🚀 Starting migration process..." "$YELLOW"
migration_response=$(curl -s -X POST "$WORKER_URL/migrate")
migration_exit_code=$?

if [ $migration_exit_code -ne 0 ]; then
    log_color "❌ Migration request failed" "$RED"
    exit 1
fi

# Parse migration results
echo "$migration_response" | jq '.' > /tmp/migration_results.json

if echo "$migration_response" | jq -e '.error' > /dev/null; then
    log_color "❌ Migration failed:" "$RED"
    echo "$migration_response" | jq -r '.message'
    exit 1
fi

# Extract migration statistics
todoist_processed=$(echo "$migration_response" | jq -r '.todoistTasks.processed')
todoist_migrated=$(echo "$migration_response" | jq -r '.todoistTasks.migrated')
todoist_errors=$(echo "$migration_response" | jq -r '.todoistTasks.errors')

legacy_processed=$(echo "$migration_response" | jq -r '.legacyMappings.processed')
legacy_migrated=$(echo "$migration_response" | jq -r '.legacyMappings.migrated')
legacy_errors=$(echo "$migration_response" | jq -r '.legacyMappings.errors')

log_color "✅ Migration completed successfully!" "$GREEN"
echo
log_color "📊 Migration Results:" "$BLUE"
echo "   📱 Todoist Tasks:"
echo "      • Processed: $todoist_processed"
echo "      • Migrated: $todoist_migrated"
echo "      • Errors: $todoist_errors"
echo
echo "   🗂️  Legacy Mappings:"
echo "      • Processed: $legacy_processed"
echo "      • Migrated: $legacy_migrated"
echo "      • Errors: $legacy_errors"
echo

# Show migration summary if available
if echo "$migration_response" | jq -e '.summary[]' > /dev/null; then
    log_color "📝 Migration Details:" "$BLUE"
    echo "$migration_response" | jq -r '.summary[]' | head -10 | while read line; do
        echo "   • $line"
    done
    
    total_summary=$(echo "$migration_response" | jq -r '.summary | length')
    if [ "$total_summary" -gt 10 ]; then
        echo "   ... and $((total_summary - 10)) more items"
    fi
    echo
fi

# Get post-migration status
log_color "📊 Getting post-migration status..." "$BLUE"
sleep 2  # Give system time to settle
post_status_response=$(curl -s "$WORKER_URL/sync/status")

if [ $? -eq 0 ]; then
    echo "$post_status_response" | jq '.' > /tmp/post_migration_status.json
    
    hash_mappings=$(echo "$post_status_response" | jq -r '.fingerprint.hashMappings')
    migration_progress=$(echo "$post_status_response" | jq -r '.migration.progress')
    is_complete=$(echo "$post_status_response" | jq -r '.migration.isComplete')
    
    log_color "📈 Post-migration Summary:" "$BLUE"
    echo "   • Hash-based mappings: $hash_mappings"
    echo "   • Migration progress: $migration_progress"
    echo "   • Migration complete: $is_complete"
    echo
    
    if [ "$is_complete" = "true" ]; then
        log_color "🎉 Migration fully complete! System ready for tag-free operation." "$GREEN"
    else
        log_color "⚠️  Migration partially complete. Check recommendations below." "$YELLOW"
        echo "$post_status_response" | jq -r '.migration.recommendations[]' | while read rec; do
            echo "   • $rec"
        done
    fi
else
    log_color "⚠️  Could not get post-migration status" "$YELLOW"
fi

echo
log_color "📁 Migration logs saved to: $LOG_FILE" "$BLUE"
log_color "📄 Status files saved to /tmp/*migration*.json" "$BLUE"

echo
echo "🔄 Migration script completed!"
echo "You can now test the new fingerprint-based system."
