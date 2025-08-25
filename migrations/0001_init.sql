-- D1 schema for KV-compatible storage
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expiration INTEGER NULL,
  metadata TEXT NULL,
  updated_at INTEGER NOT NULL
);

-- Index to speed up prefix scans (leveraging ordered key)
-- D1/SQLite uses the PK index for ORDER BY key, so this is optional.

