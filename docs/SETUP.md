# Todoist-Things Sync Setup Guide

## Table of Contents
- [Prerequisites](#prerequisites)
- [Quick Setup](#quick-setup)
- [Manual Setup](#manual-setup)
- [Configuration](#configuration)
- [Usage](#usage)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)

## Prerequisites

### System Requirements
- **macOS** (10.14 Mojave or later)
- **Things 3** installed and configured
- **Node.js** (v16 or later) and npm
- **Todoist account** with API access
- **Cloudflare account** (free tier is sufficient)

### Required Accounts
1. **Todoist API Token**
   - Go to [Todoist Integrations](https://todoist.com/prefs/integrations)
   - Find "API token" section
   - Copy your personal API token

2. **Cloudflare Account**
   - Sign up at [Cloudflare](https://dash.cloudflare.com/sign-up)
   - No paid plan required

## Quick Setup

### Automated Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/sync-todoist-things.git
   cd sync-todoist-things
   ```

2. **Run the setup wizard**
   ```bash
   chmod +x scripts/setup.sh
   ./scripts/setup.sh
   ```

3. **Follow the prompts**
   - Enter your Todoist API token
   - Configure your Worker URL
   - Choose sync preferences
   - Enable automatic sync (optional)

The setup wizard will:
- ✅ Check system requirements
- ✅ Validate API tokens
- ✅ Deploy the Cloudflare Worker
- ✅ Configure automatic sync
- ✅ Run initial synchronization
- ✅ Perform health check

## Manual Setup

### Step 1: Install Dependencies

```bash
# Install Node.js dependencies
npm install

# Install Cloudflare Wrangler globally
npm install -g wrangler
```

### Step 2: Configure Cloudflare Worker

1. **Login to Cloudflare**
   ```bash
   wrangler login
   ```

2. **Create KV namespace**
   ```bash
   wrangler kv:namespace create "SYNC_METADATA"
   ```

3. **Update wrangler.toml**
   ```toml
   name = "todoist-things-sync"
   main = "src/index.ts"
   compatibility_date = "2024-01-01"

   [[kv_namespaces]]
   binding = "SYNC_METADATA"
   id = "YOUR_KV_NAMESPACE_ID"

   [vars]
   TODOIST_API_TOKEN = "YOUR_TODOIST_API_TOKEN"
   REPAIR_AUTH_TOKEN = "YOUR_SECURE_TOKEN"
   ```

4. **Deploy the Worker**
   ```bash
   wrangler deploy
   ```

### Step 3: Configure Local Scripts

1. **Set environment variables**
   ```bash
   export TODOIST_THINGS_WORKER_URL="https://todoist-things-sync.YOUR-SUBDOMAIN.workers.dev"
   export TODOIST_API_TOKEN="YOUR_TODOIST_API_TOKEN"
   ```

2. **Copy scripts to Library folder**
   ```bash
   mkdir -p ~/Library/Scripts/todoist-things-sync
   cp scripts/*.sh ~/Library/Scripts/todoist-things-sync/
   cp scripts/*.applescript ~/Library/Scripts/todoist-things-sync/
   chmod +x ~/Library/Scripts/todoist-things-sync/*
   ```

### Step 4: Setup Automatic Sync (Optional)

1. **Create LaunchAgent**
   ```bash
   cp scripts/com.todoist-things.sync.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.todoist-things.sync.plist
   ```

2. **Verify it's running**
   ```bash
   launchctl list | grep todoist-things
   ```

## Configuration

### Sync Configuration

Configure sync behavior via the API:

```bash
# Get current configuration
curl https://YOUR-WORKER-URL/config

# Update configuration
curl -X PUT https://YOUR-WORKER-URL/config \
  -H "Content-Type: application/json" \
  -d '{
    "conflictStrategy": "newest_wins",
    "autoResolveConflicts": true,
    "enabledProjects": ["Work", "Personal"],
    "excludedTags": ["draft", "synced-from-todoist"]
  }'
```

### Conflict Resolution Strategies

- **`todoist_wins`** - Always use Todoist version
- **`things_wins`** - Always use Things version
- **`newest_wins`** - Use most recently modified (default)
- **`merge`** - Intelligently merge non-conflicting changes
- **`manual`** - Store conflicts for manual resolution

### Project and Tag Filtering

Configure which projects and tags to sync:

```applescript
# Configure filters via AppleScript
osascript scripts/configure-sync-filters.applescript "Work,Personal" "important,urgent" "draft,archive"
```

Or use the enhanced sync script which reads configuration from the API:
```bash
./scripts/sync-bidirectional-v2.sh
```

## Usage

### Manual Sync

```bash
# Run a manual sync
~/Library/Scripts/todoist-things-sync/sync-bidirectional-v2.sh

# Sync with specific configuration
ENABLED_PROJECTS="Work" ./scripts/sync-bidirectional-v2.sh
```

### View Sync Status

```bash
# Check health
curl https://YOUR-WORKER-URL/health

# View metrics
curl https://YOUR-WORKER-URL/metrics?hours=24

# List conflicts
curl https://YOUR-WORKER-URL/conflicts

# Check sync status
curl https://YOUR-WORKER-URL/sync/status
```

### Resolve Conflicts

```bash
# List unresolved conflicts
curl https://YOUR-WORKER-URL/conflicts

# Resolve a specific conflict
curl -X POST https://YOUR-WORKER-URL/conflicts/resolve \
  -H "Content-Type: application/json" \
  -d '{
    "conflictId": "conflict-123",
    "strategy": "todoist_wins"
  }'
```

### Bulk Operations

```bash
# Force re-sync all tasks (requires auth)
curl -X POST https://YOUR-WORKER-URL/sync/bulk \
  -H "X-Repair-Auth: YOUR_REPAIR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"direction": "both"}'
```

## Troubleshooting

### Common Issues

#### Things 3 Not Responding
- **Solution**: Ensure Things 3 is running and has granted AppleScript permissions
- Check: System Preferences → Security & Privacy → Privacy → Automation

#### Sync Not Running Automatically
- **Check LaunchAgent**:
  ```bash
  launchctl list | grep todoist-things
  ```
- **View logs**:
  ```bash
  tail -f ~/Library/Logs/todoist-things-sync.log
  ```

#### Duplicate Tasks
- **Solution**: Run deduplication
  ```bash
  curl -X POST https://YOUR-WORKER-URL/sync/verify
  ```

#### API Token Invalid
- **Solution**: Regenerate token in Todoist settings and update configuration
  ```bash
  wrangler secret put TODOIST_API_TOKEN
  ```

### Debug Commands

```bash
# Check task mappings
curl https://YOUR-WORKER-URL/debug/mappings

# Preview hash computation
curl "https://YOUR-WORKER-URL/debug/hash?title=Task&notes=Notes"

# View specific KV entry
curl "https://YOUR-WORKER-URL/debug/kv/hash:HASH_VALUE"
```

### Reset Sync State

⚠️ **Warning**: This will clear all sync history

```bash
# Clear all mappings (requires auth)
curl -X POST https://YOUR-WORKER-URL/inbox/unmark-all \
  -H "X-Repair-Auth: YOUR_REPAIR_TOKEN"
```

## FAQ

### Q: How often does the sync run?
**A:** By default, every 5 minutes when using the LaunchAgent. You can modify this in the plist file.

### Q: Can I sync specific projects only?
**A:** Yes! Configure project filtering via the API or AppleScript configuration.

### Q: What happens when I modify a task in both apps?
**A:** The conflict resolution system will detect this and either:
- Auto-resolve based on your configured strategy
- Store the conflict for manual resolution

### Q: Is my data secure?
**A:** Yes. Data is:
- Transmitted over HTTPS
- Stored in your private Cloudflare KV namespace
- Never shared with third parties
- API tokens are stored securely

### Q: Can I use multiple devices?
**A:** Yes, but:
- Run the sync script on one Mac only
- Things 3 will sync across devices via iCloud
- Todoist syncs automatically across all platforms

### Q: How do I update the sync system?
**A:** 
```bash
git pull origin main
npm install
wrangler deploy
```

### Q: How do I uninstall?
**A:**
```bash
# Stop automatic sync
launchctl unload ~/Library/LaunchAgents/com.todoist-things.sync.plist
rm ~/Library/LaunchAgents/com.todoist-things.sync.plist

# Remove scripts
rm -rf ~/Library/Scripts/todoist-things-sync

# Remove configuration
rm ~/.todoist-things-sync

# Delete Cloudflare Worker (optional)
wrangler delete
```

## Support

For issues or questions:
1. Check the [troubleshooting section](#troubleshooting)
2. View logs: `~/Library/Logs/todoist-things-sync.log`
3. Open an issue on GitHub
4. Check worker metrics for sync statistics

## Advanced Configuration

### Custom Sync Intervals

Edit the LaunchAgent plist:
```xml
<key>StartInterval</key>
<integer>600</integer><!-- 10 minutes -->
```

### Multiple Configurations

Create different configuration files:
```bash
# Work configuration
TODOIST_THINGS_CONFIG=~/.todoist-things-work ./sync-bidirectional-v2.sh

# Personal configuration  
TODOIST_THINGS_CONFIG=~/.todoist-things-personal ./sync-bidirectional-v2.sh
```

### Webhook Integration (Future)

The system is designed to support webhooks for real-time sync:
```javascript
// Coming soon: Real-time sync via webhooks
POST /webhook/todoist
POST /webhook/things
```