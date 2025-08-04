#!/bin/bash

# Script to clean up duplicate tasks in Things
# Removes duplicates found by the duplicate detection script

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_color() {
    echo -e "${2}$(date '+%Y-%m-%d %H:%M:%S') - $1${NC}"
}

echo "🧹 Cleaning Up Duplicate Tasks in Things"
echo "========================================"
echo

# Find duplicates
log_color "🔍 Finding duplicates in Things..." "$BLUE"
duplicates_json=$("${SCRIPT_DIR}/find-duplicates-things.applescript")

if [ $? -ne 0 ]; then
    log_color "❌ Failed to find duplicates" "$RED"
    exit 1
fi

# Count duplicates
duplicate_count=$(echo "$duplicates_json" | jq length)

if [ "$duplicate_count" -eq 0 ]; then
    log_color "✨ No duplicates found - Things is clean!" "$GREEN"
    exit 0
fi

log_color "📊 Found $duplicate_count duplicate sets" "$YELLOW"
echo

# Show duplicates
echo "$duplicates_json" | jq -r '.[] | "   • \(.name) (original: \(.original_id), duplicate: \(.duplicate_id))"'
echo

# Ask for confirmation
echo -e "${YELLOW}⚠️  This will delete the duplicate tasks (keeping originals).${NC}"
echo -e "${YELLOW}   Make sure you have a backup of your Things data!${NC}"
echo
read -p "Do you want to proceed with cleanup? (y/N): " -n 1 -r
echo

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_color "❌ Cleanup cancelled by user" "$YELLOW"
    exit 0
fi

# Clean up duplicates
log_color "🧹 Starting duplicate cleanup..." "$BLUE"

cleanup_result=$("${SCRIPT_DIR}/cleanup-duplicates-things.applescript" "delete" 2>&1)
cleanup_exit_code=$?

if [ $cleanup_exit_code -eq 0 ]; then
    log_color "✅ Cleanup completed successfully!" "$GREEN"
    echo "$cleanup_result"
else
    log_color "❌ Cleanup failed:" "$RED"
    echo "$cleanup_result"
    exit 1
fi

# Verify cleanup
log_color "🔍 Verifying cleanup..." "$BLUE"
sleep 2

post_cleanup_duplicates=$("${SCRIPT_DIR}/find-duplicates-things.applescript")
post_duplicate_count=$(echo "$post_cleanup_duplicates" | jq length)

log_color "📊 Post-cleanup Summary:" "$BLUE"
echo "   • Duplicates before: $duplicate_count"
echo "   • Duplicates after: $post_duplicate_count"
echo "   • Cleaned: $((duplicate_count - post_duplicate_count))"

if [ "$post_duplicate_count" -eq 0 ]; then
    log_color "🎉 All duplicates cleaned! Things is now duplicate-free." "$GREEN"
else
    log_color "⚠️  Some duplicates remain. Manual review may be needed." "$YELLOW"
fi

echo
log_color "🧹 Duplicate cleanup completed!" "$GREEN"
