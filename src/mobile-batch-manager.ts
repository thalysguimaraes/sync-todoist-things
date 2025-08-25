import { Env } from './types';
import type { MobileTaskMapping } from './mobile-types';

export interface MobileBatchState {
  mappings: Map<string, MobileTaskMapping>;
  lastUpdated: string;
  version: number;
}

export interface MobileBatchEntry {
  deviceId: string;
  mappings: Record<string, MobileTaskMapping>;
  lastUpdated: string;
  version: number;
}

export class MobileBatchManager {
  private env: Env;
  private batchCache: Map<string, MobileBatchState> = new Map();
  private pendingWrites: Map<string, MobileBatchState> = new Map();
  
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get all mappings for a device (batched read)
   */
  async getDeviceMappings(deviceId: string): Promise<Map<string, MobileTaskMapping>> {
    // Check cache first
    if (this.batchCache.has(deviceId)) {
      return this.batchCache.get(deviceId)!.mappings;
    }

    // Check pending writes
    if (this.pendingWrites.has(deviceId)) {
      return this.pendingWrites.get(deviceId)!.mappings;
    }

    // Load from KV
    const batchKey = `mobile-batch:${deviceId}`;
    const batchData = await this.env.SYNC_METADATA.get(batchKey);
    
    if (batchData) {
      const entry: MobileBatchEntry = JSON.parse(batchData);
      const state: MobileBatchState = {
        mappings: new Map(Object.entries(entry.mappings)),
        lastUpdated: entry.lastUpdated,
        version: entry.version || 1
      };
      
      this.batchCache.set(deviceId, state);
      return state.mappings;
    }

    // No existing batch, return empty map
    return new Map();
  }

  /**
   * Get a specific task mapping for a device
   */
  async getTaskMapping(deviceId: string, taskId: string): Promise<MobileTaskMapping | null> {
    const mappings = await this.getDeviceMappings(deviceId);
    return mappings.get(taskId) || null;
  }

  /**
   * Add or update a task mapping (batched write)
   */
  async setTaskMapping(deviceId: string, taskId: string, mapping: MobileTaskMapping): Promise<void> {
    // Get current state
    let state = this.pendingWrites.get(deviceId);
    
    if (!state) {
      const currentMappings = await this.getDeviceMappings(deviceId);
      state = {
        mappings: new Map(currentMappings),
        lastUpdated: new Date().toISOString(),
        version: (this.batchCache.get(deviceId)?.version || 0) + 1
      };
    }

    // Update mapping
    state.mappings.set(taskId, mapping);
    state.lastUpdated = new Date().toISOString();
    
    // Store in pending writes
    this.pendingWrites.set(deviceId, state);
  }

  /**
   * Remove a task mapping (batched delete)
   */
  async deleteTaskMapping(deviceId: string, taskId: string): Promise<void> {
    // Get current state
    let state = this.pendingWrites.get(deviceId);
    
    if (!state) {
      const currentMappings = await this.getDeviceMappings(deviceId);
      state = {
        mappings: new Map(currentMappings),
        lastUpdated: new Date().toISOString(),
        version: (this.batchCache.get(deviceId)?.version || 0) + 1
      };
    }

    // Delete mapping
    state.mappings.delete(taskId);
    state.lastUpdated = new Date().toISOString();
    
    // Store in pending writes
    this.pendingWrites.set(deviceId, state);
  }

  /**
   * Flush all pending writes to KV storage
   */
  async flush(): Promise<void> {
    const writePromises: Promise<void>[] = [];

    for (const [deviceId, state] of this.pendingWrites) {
      const batchKey = `mobile-batch:${deviceId}`;
      
      // Convert to storage format
      const entry: MobileBatchEntry = {
        deviceId,
        mappings: Object.fromEntries(state.mappings),
        lastUpdated: state.lastUpdated,
        version: state.version
      };

      // Write to KV
      writePromises.push(
        this.env.SYNC_METADATA.put(batchKey, JSON.stringify(entry))
          .then(() => {
            // Update cache
            this.batchCache.set(deviceId, state);
          })
      );
    }

    // Wait for all writes to complete
    await Promise.all(writePromises);
    
    // Clear pending writes
    this.pendingWrites.clear();
  }

  /**
   * Migrate existing individual keys to batch format
   */
  async migrateDeviceData(deviceId: string): Promise<void> {
    const prefix = `mobile-mapping:${deviceId}:`;
    const existingKeys = await this.env.SYNC_METADATA.list({ prefix });
    
    if (existingKeys.keys.length === 0) {
      return; // No data to migrate
    }

    const mappings = new Map<string, MobileTaskMapping>();
    const deletePromises: Promise<void>[] = [];

    // Fetch all individual mappings
    for (const key of existingKeys.keys) {
      const taskId = key.name.replace(prefix, '');
      const data = await this.env.SYNC_METADATA.get(key.name);
      
      if (data) {
        mappings.set(taskId, JSON.parse(data));
        // Mark for deletion after migration
        deletePromises.push(this.env.SYNC_METADATA.delete(key.name));
      }
    }

    // Save as batch
    const batchEntry: MobileBatchEntry = {
      deviceId,
      mappings: Object.fromEntries(mappings),
      lastUpdated: new Date().toISOString(),
      version: 1
    };

    await this.env.SYNC_METADATA.put(
      `mobile-batch:${deviceId}`,
      JSON.stringify(batchEntry)
    );

    // Delete old individual keys
    await Promise.all(deletePromises);

    console.log(`Migrated ${mappings.size} mappings for device ${deviceId}`);
  }

  /**
   * Get statistics about batch usage
   */
  async getStats(deviceId?: string): Promise<{
    devices: number;
    totalMappings: number;
    cacheSize: number;
    pendingWrites: number;
  }> {
    if (deviceId) {
      const mappings = await this.getDeviceMappings(deviceId);
      return {
        devices: 1,
        totalMappings: mappings.size,
        cacheSize: this.batchCache.has(deviceId) ? 1 : 0,
        pendingWrites: this.pendingWrites.has(deviceId) ? 1 : 0
      };
    }

    // Get all device batches
    const batches = await this.env.SYNC_METADATA.list({ prefix: 'mobile-batch:' });
    let totalMappings = 0;

    for (const key of batches.keys) {
      const data = await this.env.SYNC_METADATA.get(key.name);
      if (data) {
        const entry: MobileBatchEntry = JSON.parse(data);
        totalMappings += Object.keys(entry.mappings).length;
      }
    }

    return {
      devices: batches.keys.length,
      totalMappings,
      cacheSize: this.batchCache.size,
      pendingWrites: this.pendingWrites.size
    };
  }

  /**
   * Clear cache for memory management
   */
  clearCache(): void {
    this.batchCache.clear();
  }
}
