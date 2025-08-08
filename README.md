# Todoist ↔ Things Bidirectional Sync

![Todoist Things Sync Banner](public/banner-image.jpg)

A powerful Cloudflare Worker that enables automatic bidirectional synchronization between Todoist and Things 3, with advanced conflict resolution, selective sync, and comprehensive monitoring. Perfect for users who want to use Things on Apple devices while maintaining access to their tasks on other platforms through Todoist.

## 🎯 Key Features

- **🔄 Bidirectional Sync**: Tasks created in either app automatically appear in the other
- **🤝 Conflict Resolution**: Smart detection and resolution when tasks are modified in both apps
- **🎯 Selective Sync**: Filter by projects and tags - sync only what you need
- **🚫 Duplicate Prevention**: Advanced fingerprint-based deduplication
- **📊 Performance Metrics**: Track sync performance and monitor health
- **⚡ Idempotency**: Safe request retry with automatic deduplication
- **🔧 Configuration API**: Customize sync behavior via REST API
- **🚀 Easy Setup**: Automated setup wizard for quick deployment
- **📝 Comprehensive Testing**: 55+ unit tests and integration tests

## 🏗 Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Todoist   │────▶│ Cloudflare Worker│◀────│  Things 3   │
│   (Inbox)   │     │   with KV Store  │     │  (Inbox)    │
└─────────────┘     └──────────────────┘     └─────────────┘
       ▲                    │                        │
       │              Conflict Resolution            │
       │              Metrics & Monitoring           │
       └─────────────── macOS Scripts ◀──────────────┘
                    (LaunchAgent + AppleScript)
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

## 📖 Usage

### Automatic Sync

Once configured, the LaunchAgent runs automatically every 5 minutes. Enhanced sync features include:

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

### Maintenance
- `POST /sync/bulk` - Bulk sync operations (auth required)
- `POST /metrics/cleanup` - Clean old metrics (auth required)

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