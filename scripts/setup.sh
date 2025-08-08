#!/bin/bash

# Automated setup script for Todoist-Things bidirectional sync
# This script configures the entire sync system with minimal user input

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration variables
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
USER_HOME="$HOME"
CONFIG_FILE="$USER_HOME/.todoist-things-sync"

# Functions
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_header() {
    echo ""
    echo "========================================="
    echo "$1"
    echo "========================================="
    echo ""
}

# Check system requirements
check_requirements() {
    print_header "Checking System Requirements"
    
    # Check for macOS
    if [[ "$OSTYPE" != "darwin"* ]]; then
        print_error "This script requires macOS"
        exit 1
    fi
    print_success "macOS detected"
    
    # Check for Things 3
    if ! osascript -e 'tell application "System Events" to get name of every application process' 2>/dev/null | grep -q "Things3"; then
        print_warning "Things 3 is not running. Please open Things 3 and run this script again."
        echo -n "Do you want to open Things 3 now? (y/n): "
        read -r open_things
        if [[ "$open_things" == "y" ]]; then
            open -a "Things3" 2>/dev/null || {
                print_error "Failed to open Things 3. Please open it manually."
                exit 1
            }
            echo "Waiting for Things 3 to start..."
            sleep 3
        else
            exit 1
        fi
    fi
    print_success "Things 3 is installed and running"
    
    # Check for Node.js
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        echo "Please install Node.js from https://nodejs.org/"
        exit 1
    fi
    print_success "Node.js $(node --version) installed"
    
    # Check for npm
    if ! command -v npm &> /dev/null; then
        print_error "npm is not installed"
        exit 1
    fi
    print_success "npm $(npm --version) installed"
    
    # Check for Wrangler (Cloudflare CLI)
    if ! command -v wrangler &> /dev/null; then
        print_warning "Wrangler is not installed"
        echo -n "Do you want to install Wrangler now? (y/n): "
        read -r install_wrangler
        if [[ "$install_wrangler" == "y" ]]; then
            npm install -g wrangler
            print_success "Wrangler installed"
        else
            print_error "Wrangler is required for deployment"
            exit 1
        fi
    else
        print_success "Wrangler installed"
    fi
}

# Configure API tokens
configure_tokens() {
    print_header "Configuring API Tokens"
    
    # Load existing config if it exists
    if [[ -f "$CONFIG_FILE" ]]; then
        source "$CONFIG_FILE"
        print_success "Loaded existing configuration"
    fi
    
    # Todoist API Token
    if [[ -z "$TODOIST_API_TOKEN" ]]; then
        echo "Please enter your Todoist API token:"
        echo "(Get it from: https://todoist.com/prefs/integrations)"
        read -r -s TODOIST_API_TOKEN
        echo ""
    else
        print_success "Using existing Todoist API token"
    fi
    
    # Validate Todoist token
    echo -n "Validating Todoist API token... "
    if curl -s -H "Authorization: Bearer $TODOIST_API_TOKEN" https://api.todoist.com/rest/v2/projects | grep -q '"id"'; then
        print_success "Todoist API token is valid"
    else
        print_error "Invalid Todoist API token"
        unset TODOIST_API_TOKEN
        exit 1
    fi
    
    # Worker URL
    if [[ -z "$TODOIST_THINGS_WORKER_URL" ]]; then
        echo ""
        echo "Please enter your Cloudflare Worker URL:"
        echo "(e.g., https://todoist-things-sync.your-subdomain.workers.dev)"
        read -r TODOIST_THINGS_WORKER_URL
    else
        print_success "Using existing Worker URL: $TODOIST_THINGS_WORKER_URL"
    fi
    
    # Validate Worker URL
    echo -n "Validating Worker URL... "
    if curl -s "$TODOIST_THINGS_WORKER_URL/health" | grep -q '"status":"ok"'; then
        print_success "Worker is responding"
    else
        print_warning "Worker is not responding. Make sure it's deployed."
    fi
    
    # Repair Auth Token (optional)
    if [[ -z "$REPAIR_AUTH_TOKEN" ]]; then
        echo ""
        echo "Enter a repair auth token for admin operations (or press Enter to generate one):"
        read -r -s REPAIR_AUTH_TOKEN
        if [[ -z "$REPAIR_AUTH_TOKEN" ]]; then
            REPAIR_AUTH_TOKEN=$(openssl rand -base64 32)
            echo "Generated repair token: $REPAIR_AUTH_TOKEN"
            echo "(Save this token for admin operations)"
        fi
    else
        print_success "Using existing repair auth token"
    fi
    
    # Save configuration
    cat > "$CONFIG_FILE" << EOF
# Todoist-Things Sync Configuration
export TODOIST_API_TOKEN="$TODOIST_API_TOKEN"
export TODOIST_THINGS_WORKER_URL="$TODOIST_THINGS_WORKER_URL"
export REPAIR_AUTH_TOKEN="$REPAIR_AUTH_TOKEN"
EOF
    
    chmod 600 "$CONFIG_FILE"
    print_success "Configuration saved to $CONFIG_FILE"
}

# Install dependencies
install_dependencies() {
    print_header "Installing Dependencies"
    
    cd "$PROJECT_ROOT"
    
    if [[ -f "package.json" ]]; then
        echo "Installing npm packages..."
        npm install
        print_success "Dependencies installed"
    else
        print_warning "No package.json found in project root"
    fi
}

# Setup Cloudflare Worker
setup_worker() {
    print_header "Setting up Cloudflare Worker"
    
    cd "$PROJECT_ROOT"
    
    # Check if wrangler.toml exists
    if [[ ! -f "wrangler.toml" ]]; then
        print_error "wrangler.toml not found"
        exit 1
    fi
    
    # Update wrangler.toml with tokens
    echo -n "Do you want to deploy the worker now? (y/n): "
    read -r deploy_worker
    
    if [[ "$deploy_worker" == "y" ]]; then
        # Set environment variables for wrangler
        export TODOIST_API_TOKEN
        export REPAIR_AUTH_TOKEN
        
        echo "Deploying worker..."
        wrangler deploy
        
        if [[ $? -eq 0 ]]; then
            print_success "Worker deployed successfully"
        else
            print_error "Worker deployment failed"
            exit 1
        fi
    else
        print_warning "Skipping worker deployment"
        echo "You can deploy later with: wrangler deploy"
    fi
}

# Setup LaunchAgent for automatic sync
setup_launchagent() {
    print_header "Setting up Automatic Sync"
    
    echo -n "Do you want to set up automatic sync every 5 minutes? (y/n): "
    read -r setup_auto
    
    if [[ "$setup_auto" != "y" ]]; then
        print_warning "Skipping automatic sync setup"
        return
    fi
    
    # Copy scripts to Library folder
    SCRIPTS_DIR="$USER_HOME/Library/Scripts/todoist-things-sync"
    mkdir -p "$SCRIPTS_DIR"
    
    echo "Copying scripts..."
    cp "$SCRIPT_DIR"/*.sh "$SCRIPTS_DIR/"
    cp "$SCRIPT_DIR"/*.applescript "$SCRIPTS_DIR/"
    chmod +x "$SCRIPTS_DIR"/*.sh
    chmod +x "$SCRIPTS_DIR"/*.applescript
    print_success "Scripts copied to $SCRIPTS_DIR"
    
    # Create LaunchAgent plist
    PLIST_PATH="$USER_HOME/Library/LaunchAgents/com.todoist-things.sync.plist"
    
    cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.todoist-things.sync</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SCRIPTS_DIR/sync-bidirectional-v2.sh</string>
    </array>
    
    <key>StartInterval</key>
    <integer>300</integer><!-- Sync every 5 minutes -->
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>$USER_HOME/Library/Logs/todoist-things-sync.log</string>
    
    <key>StandardErrorPath</key>
    <string>$USER_HOME/Library/Logs/todoist-things-sync.error.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>TODOIST_THINGS_WORKER_URL</key>
        <string>$TODOIST_THINGS_WORKER_URL</string>
    </dict>
</dict>
</plist>
EOF
    
    print_success "LaunchAgent created"
    
    # Load LaunchAgent
    echo "Loading LaunchAgent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    
    if [[ $? -eq 0 ]]; then
        print_success "Automatic sync enabled"
    else
        print_error "Failed to enable automatic sync"
    fi
}

# Configure sync filters
configure_filters() {
    print_header "Configure Sync Filters (Optional)"
    
    echo -n "Do you want to configure project/tag filters? (y/n): "
    read -r configure_filters
    
    if [[ "$configure_filters" != "y" ]]; then
        print_warning "Skipping filter configuration"
        return
    fi
    
    echo ""
    echo "Enter projects to sync (comma-separated, or press Enter for all):"
    read -r enabled_projects
    
    echo "Enter tags to include (comma-separated, or press Enter for all):"
    read -r enabled_tags
    
    echo "Enter tags to exclude (comma-separated, default: synced-from-todoist,synced-to-todoist):"
    read -r excluded_tags
    if [[ -z "$excluded_tags" ]]; then
        excluded_tags="synced-from-todoist,synced-to-todoist"
    fi
    
    # Apply configuration
    osascript "$SCRIPT_DIR/configure-sync-filters.applescript" "$enabled_projects" "$enabled_tags" "$excluded_tags"
    
    print_success "Filters configured"
}

# Run initial sync
run_initial_sync() {
    print_header "Running Initial Sync"
    
    echo -n "Do you want to run an initial sync now? (y/n): "
    read -r run_sync
    
    if [[ "$run_sync" != "y" ]]; then
        print_warning "Skipping initial sync"
        return
    fi
    
    source "$CONFIG_FILE"
    
    echo "Running sync..."
    if [[ -f "$SCRIPT_DIR/sync-bidirectional-v2.sh" ]]; then
        "$SCRIPT_DIR/sync-bidirectional-v2.sh"
    else
        "$SCRIPT_DIR/sync-bidirectional.sh"
    fi
    
    if [[ $? -eq 0 ]]; then
        print_success "Initial sync completed"
    else
        print_error "Initial sync failed"
    fi
}

# Health check
run_health_check() {
    print_header "Running Health Check"
    
    source "$CONFIG_FILE"
    
    # Check worker health
    echo -n "Worker health: "
    if curl -s "$TODOIST_THINGS_WORKER_URL/health" | grep -q '"status":"ok"'; then
        print_success "OK"
    else
        print_error "Not responding"
    fi
    
    # Check sync status
    echo -n "Sync status: "
    status_response=$(curl -s "$TODOIST_THINGS_WORKER_URL/sync/status")
    if echo "$status_response" | grep -q '"syncLocked":false'; then
        print_success "Ready"
    else
        print_warning "Sync in progress or locked"
    fi
    
    # Check for conflicts
    echo -n "Conflicts: "
    conflicts_response=$(curl -s "$TODOIST_THINGS_WORKER_URL/conflicts")
    conflict_count=$(echo "$conflicts_response" | grep -o '"count":[0-9]*' | cut -d':' -f2)
    if [[ "$conflict_count" -eq 0 ]]; then
        print_success "No conflicts"
    else
        print_warning "$conflict_count unresolved conflicts"
    fi
    
    # Check metrics
    echo -n "Recent syncs: "
    metrics_response=$(curl -s "$TODOIST_THINGS_WORKER_URL/metrics?hours=1")
    sync_count=$(echo "$metrics_response" | grep -o '"totalSyncs":[0-9]*' | cut -d':' -f2)
    if [[ -n "$sync_count" ]]; then
        print_success "$sync_count syncs in last hour"
    else
        print_warning "No metrics available"
    fi
}

# Main setup flow
main() {
    clear
    echo "========================================="
    echo "   Todoist-Things Sync Setup Wizard"
    echo "========================================="
    echo ""
    echo "This wizard will help you set up bidirectional"
    echo "synchronization between Todoist and Things 3."
    echo ""
    echo "Press Enter to continue or Ctrl+C to cancel..."
    read -r
    
    check_requirements
    configure_tokens
    install_dependencies
    setup_worker
    setup_launchagent
    configure_filters
    run_initial_sync
    run_health_check
    
    print_header "Setup Complete!"
    
    echo "Your Todoist-Things sync is now configured."
    echo ""
    echo "Important information:"
    echo "• Configuration saved to: $CONFIG_FILE"
    echo "• Logs location: $USER_HOME/Library/Logs/todoist-things-sync.log"
    echo "• Worker URL: $TODOIST_THINGS_WORKER_URL"
    echo ""
    echo "Useful commands:"
    echo "• Manual sync: $SCRIPT_DIR/sync-bidirectional-v2.sh"
    echo "• Check health: curl $TODOIST_THINGS_WORKER_URL/health"
    echo "• View metrics: curl $TODOIST_THINGS_WORKER_URL/metrics"
    echo "• List conflicts: curl $TODOIST_THINGS_WORKER_URL/conflicts"
    echo ""
    print_success "Setup completed successfully!"
}

# Run main function
main