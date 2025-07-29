# Project: Todoist-Things Bidirectional Sync

## Overview
Cloudflare Worker that enables bidirectional synchronization between Todoist and Things 3 inboxes. Designed for users who want to use Things on Apple devices while maintaining task access on Android through Todoist.

## Architecture
- **Cloudflare Worker**: API bridge handling sync logic and deduplication
- **KV Storage**: Persistent ID mappings between platforms
- **AppleScript**: Things integration for reading/writing tasks
- **Bash Scripts**: Orchestrate bidirectional sync on macOS

## Key Features
- Bidirectional sync with duplicate prevention
- Fuzzy matching (85% threshold) for task deduplication
- Persistent ID tracking via KV storage
- Sync locking to prevent race conditions
- Smart import logic that checks existing tasks

## Recent Improvements (2025-07-29)
- Added KV namespace for persistent task ID mappings
- Implemented fuzzy matching to catch task variations
- Created custom import script to prevent duplicates
- Fixed AppleScript JSON parsing issues
- Added comprehensive duplicate cleanup capabilities
- Replaced URL-based import with controlled AppleScript

## API Endpoints
- `GET /inbox` - Fetch Todoist inbox tasks
- `POST /inbox/mark-synced` - Mark tasks as synced in Todoist
- `POST /things/sync` - Sync Things tasks to Todoist
- `GET /sync/status` - Check sync status and mappings
- `GET /health` - Health check

## Sync Flow
1. Todoist → Things: Import new tasks with duplicate checking
2. Things → Todoist: Create tasks with ID mapping
3. Both systems maintain cross-platform IDs in metadata
4. KV store tracks all task relationships

## Setup Requirements
- Cloudflare KV namespace configured
- Todoist API token
- Things 3 on macOS
- LaunchAgent for automatic sync

## Known Issues Resolved
- ✅ Duplicate tasks when syncing
- ✅ Weak deduplication logic
- ✅ Missing Things tagging after import
- ✅ Race conditions during concurrent syncs

## Testing
Worker URL: https://todoist-things-sync.thalys.workers.dev
Current stable state: 7 unique tasks, no duplicates