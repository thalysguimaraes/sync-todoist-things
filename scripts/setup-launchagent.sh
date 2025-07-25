#!/bin/bash

# Setup LaunchAgent for bidirectional sync

echo "Setting up Todoist-Things bidirectional sync..."

# Get current user home directory
USER_HOME="$HOME"
USER_NAME=$(whoami)

# Create configured plist
cat > ~/Library/LaunchAgents/com.todoist-things.bidirectional.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.todoist-things.bidirectional</string>
    
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${USER_HOME}/Library/Scripts/sync-bidirectional.sh</string>
    </array>
    
    <key>StartInterval</key>
    <integer>300</integer><!-- Sync every 5 minutes -->
    
    <key>RunAtLoad</key>
    <true/>
    
    <key>StandardOutPath</key>
    <string>${USER_HOME}/Library/Logs/todoist-things-sync.stdout.log</string>
    
    <key>StandardErrorPath</key>
    <string>${USER_HOME}/Library/Logs/todoist-things-sync.stderr.log</string>
    
    <key>EnvironmentVariables</key>
    <dict>
        <key>TODOIST_THINGS_WORKER_URL</key>
        <string>https://your-worker.workers.dev</string>
    </dict>
</dict>
</plist>
EOF

echo "✓ Created plist file"

# Unload any existing agents
echo "Unloading any existing agents..."
launchctl unload ~/Library/LaunchAgents/com.todoist-things.sync.plist 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.todoist-things.bidirectional.plist 2>/dev/null || true

# Load the new agent
echo "Loading bidirectional sync agent..."
launchctl load ~/Library/LaunchAgents/com.todoist-things.bidirectional.plist

# Verify it's loaded
if launchctl list | grep -q "com.todoist-things.bidirectional"; then
    echo "✓ Bidirectional sync agent loaded successfully"
else
    echo "✗ Failed to load agent"
    exit 1
fi

echo ""
echo "Setup complete! The bidirectional sync will run every 5 minutes."
echo "To check status: launchctl list | grep todoist"
echo "To see logs: tail -f ~/Library/Logs/todoist-things-sync.log"