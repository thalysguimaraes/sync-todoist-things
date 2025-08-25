# D1 Migration Guide

## Migration from KV to D1

This project has been refactored to use Cloudflare D1 instead of KV storage to avoid hitting KV usage limits on the free tier.

### Setup Steps

1. **Create D1 Database**
   ```bash
   wrangler d1 create todoist-things-sync
   ```

2. **Update wrangler.toml**
   Replace `YOUR_DATABASE_ID_HERE` with the database ID from step 1:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "todoist-things-sync"
   database_id = "YOUR_DATABASE_ID_HERE"
   ```

3. **Apply Migrations**
   ```bash
   wrangler d1 migrations apply todoist-things-sync --local
   wrangler d1 migrations apply todoist-things-sync --remote
   ```

4. **Deploy**
   ```bash
   wrangler deploy
   ```

## Architecture Changes

- **Storage Adapter**: Created `D1KV` class that implements KV-compatible interface backed by D1
- **Table Schema**: Single `kv` table with key-value storage, TTL support, and metadata
- **No Data Migration**: Starting fresh - current state in Todoist/Things becomes the source of truth
- **Runtime Override**: D1KV adapter is injected at runtime in `fetch()` and `scheduled()` handlers

## Benefits

- **Cost**: D1 free tier includes 5GB storage and 5M row reads/month vs KV's 1GB/100k reads
- **Performance**: Better for batch operations and complex queries
- **Scalability**: Can add indexes and optimize queries as needed