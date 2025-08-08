#!/bin/bash

# Sync Health Check Script
# Checks the consistency and health of the Todoist-Things sync system

WORKER_URL="${TODOIST_THINGS_WORKER_URL:-https://todoist-things-sync.thalys.workers.dev}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "🔍 Todoist-Things Sync Health Check"
echo "===================================="
echo

# 1. Check worker availability
echo -n "Worker availability: "
if curl -sf "$WORKER_URL/health" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Online${NC}"
else
    echo -e "${RED}❌ Offline${NC}"
    echo "Worker is not responding. Check deployment or network connection."
    exit 1
fi

# 2. Check consistency
echo -n "System consistency: "
verify_response=$(curl -s "$WORKER_URL/sync/verify" 2>/dev/null)
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Check failed${NC}"
    echo "Could not retrieve verification status"
    exit 1
fi

is_healthy=$(echo "$verify_response" | jq -r '.summary.isHealthy' 2>/dev/null)
discrepancy_count=$(echo "$verify_response" | jq -r '.summary.discrepancyCount' 2>/dev/null)

if [ "$is_healthy" = "true" ]; then
    echo -e "${GREEN}✅ Healthy${NC}"
else
    echo -e "${YELLOW}⚠️  $discrepancy_count issues found${NC}"
fi

# 3. Show summary
echo
echo "📊 System Summary:"
todoist_count=$(echo "$verify_response" | jq -r '.summary.todoistTaskCount')
mapping_count=$(echo "$verify_response" | jq -r '.summary.hashMappingCount')
echo "   • Todoist tasks: $todoist_count"
echo "   • Hash mappings: $mapping_count"

# 4. Show Things count
echo -n "   • Things tasks: "
if osascript -e 'tell application "System Events" to (name of processes) contains "Things3"' 2>/dev/null | grep -q "true"; then
    things_count=$(osascript -e 'tell application "Things3" to return count of to dos of list "Inbox"' 2>/dev/null)
    echo "$things_count"
    
    # Check if counts match
    if [ "$todoist_count" -eq "$things_count" ] 2>/dev/null; then
        echo -e "   • Count match: ${GREEN}✅ Both systems have $todoist_count tasks${NC}"
    else
        echo -e "   • Count match: ${YELLOW}⚠️  Todoist: $todoist_count, Things: $things_count${NC}"
    fi
else
    echo -e "${YELLOW}N/A (Things not running)${NC}"
fi

# 5. Show discrepancies if any
if [ "$discrepancy_count" -gt 0 ]; then
    echo
    echo -e "${YELLOW}🔧 Issues Found:${NC}"
    echo "$verify_response" | jq -r '.discrepancies[] | "   • \(.type): \(.title // .todoistId // .hashKey)"' 2>/dev/null
    
    echo
    echo -e "${BLUE}💡 Recommendations:${NC}"
    echo "$verify_response" | jq -r '.recommendations[] | "   • \(.)"' 2>/dev/null
fi

echo
if [ "$is_healthy" = "true" ]; then
    echo -e "${GREEN}🎉 Sync system is healthy!${NC}"
    exit 0
else
    echo -e "${YELLOW}⚠️  Sync system needs attention${NC}"
    echo "Run: curl $WORKER_URL/sync/verify | jq . for detailed analysis"
    exit 1
fi