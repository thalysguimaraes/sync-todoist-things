import { BatchSyncState, TaskMapping, Env } from './types';

export class BatchSyncManager {
  private state: BatchSyncState | null = null;
  private pendingUpdates: Map<string, TaskMapping> = new Map();
  private isDirty = false;

  constructor(private env: Env) {}

  async loadState(): Promise<BatchSyncState> {
    if (this.state) {
      return this.state;
    }

    const stored = await this.env.SYNC_METADATA.get('sync-state:batch');
    if (stored) {
      this.state = JSON.parse(stored);
    } else {
      this.state = {
        version: 1,
        lastUpdated: new Date().toISOString(),
        mappings: {},
        todoistIndex: {},
        thingsIndex: {},
        stats: { mappingCount: 0 }
      };
    }

    if (!this.state.stats) {
      this.state.stats = { mappingCount: Object.keys(this.state.mappings).length };
    }

    return this.state;
  }

  async getMapping(fingerprint: string): Promise<TaskMapping | null> {
    await this.loadState();
    return this.state!.mappings[fingerprint] || null;
  }

  async getMappingByTodoistId(todoistId: string): Promise<TaskMapping | null> {
    await this.loadState();
    const fingerprint = this.state!.todoistIndex[todoistId];
    if (!fingerprint) return null;
    return this.state!.mappings[fingerprint] || null;
  }

  async getMappingByThingsId(thingsId: string): Promise<TaskMapping | null> {
    await this.loadState();
    const fingerprint = this.state!.thingsIndex[thingsId];
    if (!fingerprint) return null;
    return this.state!.mappings[fingerprint] || null;
  }

  async addMapping(mapping: TaskMapping): Promise<void> {
    await this.loadState();
    const fingerprint = mapping.fingerprint.primaryHash;
    
    this.pendingUpdates.set(fingerprint, mapping);
    
    this.state!.mappings[fingerprint] = mapping;
    this.state!.todoistIndex[mapping.todoistId] = fingerprint;
    this.state!.thingsIndex[mapping.thingsId] = fingerprint;

    this.state!.stats!.mappingCount += 1;

    this.isDirty = true;
  }

  async removeMapping(fingerprint: string): Promise<void> {
    await this.loadState();
    const mapping = this.state!.mappings[fingerprint];
    if (!mapping) return;

    delete this.state!.mappings[fingerprint];
    delete this.state!.todoistIndex[mapping.todoistId];
    delete this.state!.thingsIndex[mapping.thingsId];

    this.pendingUpdates.delete(fingerprint);
    this.state!.stats!.mappingCount = Math.max(0, this.state!.stats!.mappingCount - 1);
    this.isDirty = true;
  }

  async flush(): Promise<void> {
    if (!this.isDirty || !this.state) {
      return;
    }

    this.state.lastUpdated = new Date().toISOString();
    this.state.stats!.mappingCount = Object.keys(this.state.mappings).length;
    
    try {
      await this.env.SYNC_METADATA.put(
        'sync-state:batch',
        JSON.stringify(this.state)
      );
      
      this.pendingUpdates.clear();
      this.isDirty = false;
    } catch (error) {
      console.error('Failed to flush batch sync state:', error);
      throw error;
    }
  }

  async hasMapping(fingerprint: string): Promise<boolean> {
    await this.loadState();
    return !!this.state!.mappings[fingerprint];
  }

  async getAllMappings(): Promise<TaskMapping[]> {
    await this.loadState();
    return Object.values(this.state!.mappings);
  }

  async getMappingCount(): Promise<number> {
    await this.loadState();
    return this.state!.stats?.mappingCount ?? Object.keys(this.state!.mappings).length;
  }

  async clearAll(): Promise<void> {
    this.state = {
      version: 1,
      lastUpdated: new Date().toISOString(),
      mappings: {},
      todoistIndex: {},
      thingsIndex: {},
      stats: { mappingCount: 0 }
    };
    this.pendingUpdates.clear();
    this.isDirty = true;
    await this.flush();
  }

  async migrateFromIndividualKeys(): Promise<number> {
    await this.loadState();
    
    const keys = await this.env.SYNC_METADATA.list({ prefix: 'hash:' });
    let migrated = 0;
    
    for (const key of keys.keys) {
      try {
        const mappingData = await this.env.SYNC_METADATA.get(key.name);
        if (mappingData) {
          const mapping = JSON.parse(mappingData) as TaskMapping;
          const fingerprint = key.name.replace('hash:', '');
          
          if (!this.state!.mappings[fingerprint]) {
            this.state!.mappings[fingerprint] = mapping;
            this.state!.todoistIndex[mapping.todoistId] = fingerprint;
            this.state!.thingsIndex[mapping.thingsId] = fingerprint;
            migrated++;
            this.isDirty = true;
          }
          
          await this.env.SYNC_METADATA.delete(key.name);
        }
      } catch (error) {
        console.error(`Failed to migrate key ${key.name}:`, error);
      }
    }
    
    if (this.isDirty) {
      this.state!.stats!.mappingCount = Object.keys(this.state!.mappings).length;
      this.state!.stats!.migratedLegacyMappings = (this.state!.stats!.migratedLegacyMappings || 0) + migrated;
      this.state!.stats!.pendingLegacyMigration = 0;
      await this.flush();
    }

    return migrated;
  }
}