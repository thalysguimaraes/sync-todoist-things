# Todoist ↔ Things Bidirectional Sync

![Todoist Things Sync Banner](public/banner-image.jpg)

A powerful Cloudflare Worker that enables automatic bidirectional synchronization between Todoist and Things 3, with advanced conflict resolution, selective sync, and comprehensive monitoring. Perfect for users who want to use Things on Apple devices while maintaining access to their tasks on other platforms through Todoist.

## 🎯 Key Features

- **🔄 Bidirectional Sync**: Tasks created in either app automatically appear in the other
- **🤝 Conflict Resolution**: Smart detection and resolution when tasks are modified in both apps
- **🎯 Selective Sync**: Filter by projects and tags - sync only what you need
- **🚫 Duplicate Prevention**: Advanced fingerprint-based deduplication
  - Now also normalizes Things titles (case/whitespace) to prevent near-duplicates during import
- **📊 Performance Metrics**: Track sync performance and monitor health
- **⚡ Idempotency**: Safe request retry with automatic deduplication
- **🔧 Configuration API**: Customize sync behavior via REST API
- **🪝 Webhook Integration**: Real-time sync from GitHub, Notion, Slack, and custom services
- **📡 Outbound Webhooks**: Get notified of sync events in real-time
- **⏰ CF Workers Cron**: Server-side sync coordination running every 2 minutes
- **🚀 Easy Setup**: Automated setup wizard for quick deployment
- **📝 Comprehensive Testing**: 55+ unit tests and integration tests

## ✨ What's New (2025-08-17)

- Batch-aware completion flow with reduced KV writes (prevents quota spikes)
- Deletion propagation: Things ➝ Todoist via `POST /things/sync-deleted`
- Cross-ID finalization: `POST /things/created-mappings` to persist real Things IDs back to Todoist and batch state
- Repair utilities (no data recreation):
  - `POST /repair/backfill-mappings` (use existing `[things-id:...]` in Todoist descriptions)
  - `POST /repair/backfill-by-fingerprint` (match Things ➝ Todoist by fingerprint)
  - `POST /repair/close-todoist` (authoritatively close specific Todoist tasks)
  - `POST /repair/delete-mappings` (delete specific batch mapping hashes)
- Normalized duplicate prevention in AppleScripts (title case/whitespace)
- Webhook intake stub for Todoist events (`/webhook/todoist`) to enable real-time completion/deletion propagation

## 🏗 Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Todoist   │────▶│ Cloudflare Worker│◀────│  Things 3   │
│   (Inbox)   │     │   with KV Store  │     │  (Inbox)    │
└─────────────┘     └──────────────────┘     └─────────────┘
       ▲                    │ ▲                       │
       │                    │ │                       │
       │                    │ │ Webhooks In           │
       │                    │ │ ┌─────────────┐       │
       │                    │ └─│   GitHub    │       │
       │                    │   │   Notion    │       │
       │                    │   │   Slack     │       │
       │                    │   │   Custom    │       │
       │                    │   └─────────────┘       │
       │                    │                         │
       │              Conflict Resolution             │
       │              Metrics & Monitoring            │
       │              Cron Triggers (2min)            │
       │              Outbound Webhooks               │
       └─────────────── macOS Scripts ◀───────────────┘
                  (CF Workers + AppleScript)
```

## 📋 Prerequisites

- macOS (10.14 Mojave or later)
- Things 3 for Mac
- Todoist account with API access
- Cloudflare account (free tier works)
- Node.js 16+ and npm

## 🚀 Quick Start

### Automated Setup (Recommended)

```bash
# Clone the repository
git clone https://github.com/yourusername/todoist-things-sync.git
cd todoist-things-sync

# Run the setup wizard
chmod +x scripts/setup.sh
./scripts/setup.sh
```

The setup wizard will:
- ✅ Check system requirements
- ✅ Configure API tokens
- ✅ Deploy the Cloudflare Worker
- ✅ Set up automatic sync
- ✅ Configure filtering (optional)
- ✅ Run initial sync
- ✅ Perform health check

### Manual Setup

See [docs/SETUP.md](docs/SETUP.md) for detailed manual setup instructions.

## 🔧 Configuration

### Conflict Resolution Strategies

Configure how conflicts are handled when tasks are modified in both apps:

```bash
curl -X PUT https://your-worker.workers.dev/config \
  -H "Content-Type: application/json" \
  -d '{
    "conflictStrategy": "newest_wins",
    "autoResolveConflicts": true
  }'
```

Available strategies:
- `todoist_wins` - Always use Todoist version
- `things_wins` - Always use Things version
- `newest_wins` - Use most recently modified (default)
- `merge` - Intelligently merge non-conflicting changes
- `manual` - Store conflicts for manual resolution

### Selective Sync

Filter which projects and tags to sync:

```bash
curl -X PUT https://your-worker.workers.dev/config \
  -H "Content-Type: application/json" \
  -d '{
    "enabledProjects": ["Work", "Personal"],
    "excludedTags": ["draft", "archive"]
  }'
```

Or configure via AppleScript:
```bash
osascript scripts/configure-sync-filters.applescript "Work,Personal" "important,urgent" "draft,archive"
```

## 🪝 Webhook Integration

### Inbound Webhooks (Real-time Task Creation)

Receive webhooks from external services and automatically create tasks in Things:

#### GitHub Integration
```bash
# Configure GitHub webhook
curl -X PUT https://your-worker.workers.dev/webhook/config \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "sources": {
      "github": {
        "enabled": true,
        "secret": "your-webhook-secret",
        "repositories": ["owner/repo"],
        "events": ["issues", "pull_request"]
      }
    }
  }'

# Add webhook URL to GitHub repository:
# https://your-worker.workers.dev/webhook/github
```

#### Notion Integration
```bash
# Configure Notion webhook
curl -X PUT https://your-worker.workers.dev/webhook/config \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "sources": {
      "notion": {
        "enabled": true,
        "secret": "your-webhook-secret",
        "databases": ["database-id-1"]
      }
    }
  }'

# Webhook URL: https://your-worker.workers.dev/webhook/notion
```

#### Slack Integration
```bash
# Configure Slack webhook for starred messages
curl -X PUT https://your-worker.workers.dev/webhook/config \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "sources": {
      "slack": {
        "enabled": true,
        "secret": "your-webhook-secret",
        "channels": ["C1234567890"]
      }
    }
  }'

# Webhook URL: https://your-worker.workers.dev/webhook/slack
```

#### Generic Webhooks
```bash
# Configure custom webhook with transformation rules
curl -X PUT https://your-worker.workers.dev/webhook/config \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "sources": {
      "generic": {
        "enabled": true,
        "secret": "your-webhook-secret",
        "transformRules": [{
          "name": "Jira Issue",
          "condition": {
            "field": "issue.fields.project.key",
            "operator": "equals",
            "value": "PROJ"
          },
          "transformation": {
            "title": "{{issue.fields.summary}}",
            "notes": "Jira Issue: {{issue.key}}\n{{issue.fields.description}}",
            "tags": ["jira", "{{issue.fields.priority.name}}"]
          }
        }]
      }
    }
  }'

# Webhook URL: https://your-worker.workers.dev/webhook/generic
```

### Outbound Webhooks (Event Notifications)

Get notified when sync events occur:

#### Subscribe to Events
```bash
# Add webhook subscriber
curl -X POST https://your-worker.workers.dev/webhook/subscribers \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhook",
    "secret": "your-secret",
    "events": ["task_synced", "conflict_detected", "sync_completed"],
    "enabled": true
  }'
```

#### Available Events
- `task_synced` - Tasks successfully synced between systems
- `conflict_detected` - Sync conflict detected
- `conflict_resolved` - Conflict automatically resolved
- `sync_completed` - Sync operation completed successfully
- `sync_failed` - Sync operation failed

#### Webhook Payload Example
```json
{
  "event": "task_synced",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "source": "things",
    "target": "todoist",
    "tasksCreated": 3,
    "conflictsResolved": 1
  },
  "signature": "sha256=..."
}
```

## 📖 Usage

### Automatic Sync

The system now offers two sync modes:

**CF Workers Cron (Recommended)**: Server-side sync coordination runs every 2 minutes globally
**Local LaunchAgent**: Traditional client-side sync every 5 minutes

Enhanced sync features include:

- Conflict detection and resolution
- Project/tag filtering
- Performance metrics tracking
- Error notifications

### Manual Sync

```bash
# Run enhanced bidirectional sync
~/Library/Scripts/todoist-things-sync/sync-bidirectional-v2.sh

# Run original sync (without filtering)
~/Library/Scripts/todoist-things-sync/sync-bidirectional.sh

# Check sync status
curl https://your-worker.workers.dev/sync/status
```

### View Metrics

```bash
# Performance metrics (last 24 hours)
curl https://your-worker.workers.dev/metrics

# List unresolved conflicts
curl https://your-worker.workers.dev/conflicts

# Health check
curl https://your-worker.workers.dev/health
```

### Resolve Conflicts

```bash
# List conflicts
curl https://your-worker.workers.dev/conflicts

# Resolve specific conflict
curl -X POST https://your-worker.workers.dev/conflicts/resolve \
  -H "Content-Type: application/json" \
  -d '{"conflictId": "conflict-123", "strategy": "merge"}'
```

## 🔌 API Endpoints

### Core Sync
- `GET /inbox` - Fetch Todoist inbox tasks
- `POST /things/sync` - Sync from Things to Todoist
- `POST /things/sync-completed` - Sync completed tasks
- `POST /inbox/mark-synced` - Mark tasks as synced

### Conflict Resolution
- `GET /conflicts` - List unresolved conflicts
- `POST /conflicts/resolve` - Resolve a specific conflict

### Configuration
- `GET /config` - Get current configuration
- `PUT /config` - Update configuration

### Monitoring
- `GET /metrics?hours=24` - Performance metrics
- `GET /sync/status` - Sync system status
- `GET /sync/verify` - Verify data consistency
- `GET /health` - Health check

### Webhook Management
- `POST /webhook/github` - GitHub webhook endpoint
- `POST /webhook/notion` - Notion webhook endpoint
- `POST /webhook/slack` - Slack webhook endpoint
- `POST /webhook/generic` - Generic webhook endpoint
- `POST /webhook/todoist` - Todoist webhook endpoint (completion/deletion intake)
- `GET /webhook/config` - Get webhook configuration
- `PUT /webhook/config` - Update webhook configuration
- `POST /webhook/test` - Test webhook processing
- `GET /webhook/subscribers` - List outbound webhook subscribers
- `POST /webhook/subscribers` - Add outbound webhook subscriber
- `DELETE /webhook/subscribers/{id}` - Remove webhook subscriber
- `GET /webhook/deliveries?hours=24` - View webhook delivery status

### Sync Coordination
- `GET /sync/requests` - Check for pending sync requests (CF Workers ↔ Local)
- `POST /sync/respond` - Respond with sync completion status

### Maintenance
- `POST /sync/bulk` - Bulk sync operations (auth required)
- `POST /metrics/cleanup` - Clean old metrics (auth required)
- `POST /repair/backfill-mappings` - Create batch mappings from Todoist descriptions with `[things-id:...]` (auth required)
- `POST /repair/backfill-by-fingerprint` - Create batch mappings by fingerprint using Things payload (auth required)
- `POST /repair/close-todoist` - Close specific Todoist tasks (auth required)
- `POST /repair/delete-mappings` - Delete specific batch mapping hashes (auth required)

## 🧪 Testing

```bash
# Run all tests (55+ tests)
npm test

# Run with UI
npm run test:ui

# Coverage report
npm run test:coverage
```

## 🐛 Troubleshooting

### Common Issues

**Sync not running:**
```bash
launchctl list | grep todoist
tail -f ~/Library/Logs/todoist-things-sync.log
```

**Things not responding:**
- Check System Preferences → Security & Privacy → Privacy → Automation
- Ensure Terminal has permission to control Things

**Conflicts not resolving:**
```bash
# Check conflict status
curl https://your-worker.workers.dev/conflicts

# Force manual resolution
curl -X POST https://your-worker.workers.dev/conflicts/resolve \
  -H "Content-Type: application/json" \
  -d '{"conflictId": "CONFLICT_ID", "strategy": "newest_wins"}'
```

See [docs/SETUP.md](docs/SETUP.md#troubleshooting) for comprehensive troubleshooting.

## 🛠 Development

### Project Structure

```
├── src/
│   ├── index.ts         # Main worker entry
│   ├── todoist.ts       # Todoist API client
│   ├── things.ts        # Things format converter
│   ├── conflicts.ts     # Conflict resolution system
│   ├── config.ts        # Configuration management
│   ├── metrics.ts       # Performance tracking
│   └── types.ts         # TypeScript types
├── scripts/
│   ├── setup.sh         # Automated setup wizard
│   ├── sync-bidirectional-v2.sh  # Enhanced sync
│   ├── configure-sync-filters.applescript  # Filter config
│   └── read-things-inbox-filtered.applescript  # Filtered reading
├── docs/
│   └── SETUP.md         # Detailed setup guide
└── tests/
    ├── unit/            # Unit tests
    └── integration/     # Integration tests
```

### Local Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Run tests
npm test

# Deploy to Cloudflare
npm run deploy
```

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## ⚠️ Legal Disclaimer

**This is an unofficial, open-source project and is NOT affiliated with, endorsed by, or associated with:**
- **Cultured Code GmbH & Co. KG** (makers of Things 3)
- **Doist Inc.** (makers of Todoist)

**Important Legal Notice:**
- "Things" is a trademark of Cultured Code GmbH & Co. KG
- "Todoist" is a trademark of Doist Inc.
- This project is an independent tool created for personal use
- The developers of this project are not responsible for any data loss or issues
- Use at your own risk - always backup your data
- No warranty is provided, express or implied

**By using this software, you acknowledge that:**
- This tool may stop working if either service changes their API
- You are responsible for complying with both services' Terms of Service
- The project maintainers assume no liability for any issues arising from use

## 🔗 Links

- [Todoist API Documentation](https://developer.todoist.com/rest/v2/)
- [Things URL Scheme](https://culturedcode.com/things/support/articles/2803573/)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Setup Documentation](docs/SETUP.md)
- [API Reference](CLAUDE.md)

---

Made with ❤️ for the productivity community