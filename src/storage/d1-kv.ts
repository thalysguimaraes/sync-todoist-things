// Lightweight KV-compatible wrapper backed by Cloudflare D1
// Supports: get, put, delete, list({ prefix, limit, cursor })

export interface KVListKey {
  name: string;
  expiration?: number;
  metadata?: any;
}

export interface KVListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface KVListResult {
  keys: KVListKey[];
  list_complete: boolean;
  cursor?: string;
}

export class D1KV {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  private nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  async get(key: string, options?: any): Promise<any> {
    const row = await this.db
      .prepare(
        `SELECT value, expiration, metadata FROM kv 
         WHERE key = ? AND (expiration IS NULL OR expiration > ?)`
      )
      .bind(key, this.nowSeconds())
      .first<{ value: string; expiration: number | null; metadata: string | null }>();

    if (!row) return null;

    // Handle different return types
    const type = options?.type ?? (typeof options === 'string' ? options : 'text');
    
    if (type === 'json') {
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    } else if (type === 'arrayBuffer') {
      return new TextEncoder().encode(row.value).buffer;
    } else if (type === 'stream') {
      return new Response(row.value).body;
    }
    
    return row.value;
  }

  async getWithMetadata<Metadata = unknown>(
    key: string,
    options?: any
  ): Promise<{ value: any; metadata: Metadata | null; cacheStatus: string | null }> {
    const row = await this.db
      .prepare(
        `SELECT value, expiration, metadata FROM kv 
         WHERE key = ? AND (expiration IS NULL OR expiration > ?)`
      )
      .bind(key, this.nowSeconds())
      .first<{ value: string; expiration: number | null; metadata: string | null }>();

    if (!row) {
      return { value: null, metadata: null, cacheStatus: null };
    }

    const type = options?.type ?? 'text';
    let value: any = row.value;
    
    if (type === 'json') {
      try {
        value = JSON.parse(row.value);
      } catch {
        value = null;
      }
    }

    const metadata = row.metadata ? safeParseJSON(row.metadata) : null;
    
    return { value, metadata: metadata as Metadata, cacheStatus: null };
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: any }
  ): Promise<void> {
    const now = this.nowSeconds();
    const expiration = options?.expiration
      ? options.expiration
      : options?.expirationTtl
      ? now + options.expirationTtl
      : null;
    const metadata = options?.metadata ? JSON.stringify(options.metadata) : null;

    // Upsert row
    await this.db
      .prepare(
        `INSERT INTO kv (key, value, expiration, metadata, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET 
           value = excluded.value,
           expiration = excluded.expiration,
           metadata = excluded.metadata,
           updated_at = excluded.updated_at`
      )
      .bind(key, value, expiration, metadata, now)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare(`DELETE FROM kv WHERE key = ?`).bind(key).run();
  }

  async list<Metadata = unknown>(options?: any): Promise<KVNamespaceListResult<Metadata>> {
    const prefix = options?.prefix ?? '';
    const limit = Math.min(Math.max(options?.limit ?? 1000, 1), 1000);
    const cursor = options?.cursor ?? '';
    const now = this.nowSeconds();

    let query = `SELECT key, expiration, metadata FROM kv 
                 WHERE (expiration IS NULL OR expiration > ?) `;
    const binds: any[] = [now];

    if (prefix) {
      query += `AND key LIKE ? `;
      binds.push(`${prefix}%`);
    }

    if (cursor) {
      query += `AND key > ? `;
      binds.push(cursor);
    }

    query += `ORDER BY key ASC LIMIT ?`;
    binds.push(limit + 1); // Fetch one extra to determine completeness

    const stmt = this.db.prepare(query);
    const rows = await stmt.bind(...binds).all<{ key: string; expiration: number | null; metadata: string | null }>();

    const data = rows.results ?? [];
    const hasMore = data.length > limit;
    const page = data.slice(0, limit);

    const keys = page.map((r) => ({
      name: r.key,
      expiration: r.expiration ?? undefined,
      metadata: (r.metadata ? safeParseJSON(r.metadata) : undefined) as Metadata,
    }));

    if (hasMore) {
      return {
        keys,
        list_complete: false,
        cursor: page[page.length - 1].key,
        cacheStatus: null,
      };
    } else {
      return {
        keys,
        list_complete: true,
        cacheStatus: null,
      };
    }
  }
}

function safeParseJSON(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

