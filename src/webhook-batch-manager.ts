import { Env } from './types';

export interface WebhookDelivery {
  id: string;
  webhookUrl: string;
  event: string;
  payload: any;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  error?: string;
  createdAt: string;
  lastAttempt?: string;
}

export interface WebhookBatch {
  dayBucket: number;
  deliveries: WebhookDelivery[];
  lastUpdated: string;
}

export class WebhookBatchManager {
  private env: Env;
  private pendingDeliveries: Map<number, WebhookBatch> = new Map();
  private cache: Map<number, WebhookBatch> = new Map();
  
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Get the day bucket for a timestamp
   */
  private getDayBucket(timestamp?: Date): number {
    const time = timestamp || new Date();
    return Math.floor(time.getTime() / 86400000); // Day buckets
  }

  /**
   * Record a webhook delivery
   */
  async recordDelivery(delivery: WebhookDelivery): Promise<void> {
    const dayBucket = this.getDayBucket(new Date(delivery.createdAt));
    
    // Get or create batch for this day
    let batch = this.pendingDeliveries.get(dayBucket);
    if (!batch) {
      batch = await this.loadOrCreateBatch(dayBucket);
    }

    // Add delivery to batch
    batch.deliveries.push(delivery);
    batch.lastUpdated = new Date().toISOString();
    
    this.pendingDeliveries.set(dayBucket, batch);
  }

  /**
   * Load or create a batch
   */
  private async loadOrCreateBatch(dayBucket: number): Promise<WebhookBatch> {
    // Check cache
    if (this.cache.has(dayBucket)) {
      return this.cache.get(dayBucket)!;
    }

    // Load from KV
    const key = `webhook-batch:${dayBucket}`;
    const stored = await this.env.SYNC_METADATA.get(key);
    
    if (stored) {
      const batch = JSON.parse(stored);
      this.cache.set(dayBucket, batch);
      return batch;
    }

    // Create new batch
    return {
      dayBucket,
      deliveries: [],
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get deliveries for a time range
   */
  async getDeliveries(hours: number = 24): Promise<WebhookDelivery[]> {
    const now = new Date();
    const cutoffTime = now.getTime() - (hours * 3600000);
    const startBucket = this.getDayBucket(new Date(cutoffTime));
    const endBucket = this.getDayBucket(now);
    
    const allDeliveries: WebhookDelivery[] = [];
    
    // Load all relevant batches
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const batch = await this.loadOrCreateBatch(bucket);
      
      // Filter deliveries by time
      const relevantDeliveries = batch.deliveries.filter(d => 
        new Date(d.createdAt).getTime() > cutoffTime
      );
      
      allDeliveries.push(...relevantDeliveries);
    }
    
    // Include pending deliveries
    for (const batch of this.pendingDeliveries.values()) {
      const relevantDeliveries = batch.deliveries.filter(d => 
        new Date(d.createdAt).getTime() > cutoffTime
      );
      allDeliveries.push(...relevantDeliveries);
    }
    
    // Sort by creation time (newest first)
    allDeliveries.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    return allDeliveries;
  }

  /**
   * Flush pending deliveries to KV
   */
  async flush(): Promise<void> {
    const writePromises: Promise<void>[] = [];

    for (const [bucket, batch] of this.pendingDeliveries) {
      const key = `webhook-batch:${bucket}`;
      
      // Merge with existing batch if needed
      const existingBatch = await this.loadOrCreateBatch(bucket);
      const mergedBatch = {
        ...batch,
        deliveries: [...existingBatch.deliveries, ...batch.deliveries]
      };
      
      writePromises.push(
        this.env.SYNC_METADATA.put(
          key,
          JSON.stringify(mergedBatch),
          { expirationTtl: 864000 } // 10 days TTL
        ).then(() => {
          this.cache.set(bucket, mergedBatch);
        })
      );
    }

    await Promise.all(writePromises);
    this.pendingDeliveries.clear();
  }

  /**
   * Get statistics about webhook deliveries
   */
  async getStats(hours: number = 24): Promise<{
    total: number;
    successful: number;
    failed: number;
    pending: number;
    byEvent: Record<string, number>;
    byUrl: Record<string, number>;
  }> {
    const deliveries = await this.getDeliveries(hours);
    
    const stats = {
      total: deliveries.length,
      successful: 0,
      failed: 0,
      pending: 0,
      byEvent: {} as Record<string, number>,
      byUrl: {} as Record<string, number>
    };
    
    for (const delivery of deliveries) {
      // Status counts
      if (delivery.status === 'delivered') stats.successful++;
      else if (delivery.status === 'failed') stats.failed++;
      else stats.pending++;
      
      // Event counts
      stats.byEvent[delivery.event] = (stats.byEvent[delivery.event] || 0) + 1;
      
      // URL counts
      stats.byUrl[delivery.webhookUrl] = (stats.byUrl[delivery.webhookUrl] || 0) + 1;
    }
    
    return stats;
  }

  /**
   * Clean up old deliveries
   */
  async cleanupOld(daysToKeep: number = 7): Promise<number> {
    const cutoffBucket = this.getDayBucket(
      new Date(Date.now() - daysToKeep * 86400000)
    );
    
    // List all webhook batch keys
    const batchKeys = await this.env.SYNC_METADATA.list({ prefix: 'webhook-batch:' });
    let deletedCount = 0;
    
    const deletePromises: Promise<void>[] = [];
    for (const key of batchKeys.keys) {
      const bucket = parseInt(key.name.replace('webhook-batch:', ''));
      if (bucket < cutoffBucket) {
        deletePromises.push(
          this.env.SYNC_METADATA.delete(key.name).then(() => {
            deletedCount++;
            this.cache.delete(bucket);
          })
        );
      }
    }
    
    await Promise.all(deletePromises);
    return deletedCount;
  }

  /**
   * Migrate existing individual webhook deliveries to batch format
   */
  async migrateExistingDeliveries(options?: { limit?: number; cursor?: string }): Promise<{ migrated: number; batches: number; nextCursor?: string; listComplete: boolean }> {
    const limit = options?.limit || 1000;
    const cursor = options?.cursor;
    const deliveryKeys = await this.env.SYNC_METADATA.list({ prefix: 'webhook-delivery:', limit, cursor } as any);
    const batches = new Map<number, WebhookBatch>();
    let migrated = 0;
    
    for (const key of deliveryKeys.keys) {
      const deliveryData = await this.env.SYNC_METADATA.get(key.name);
      if (!deliveryData) continue;
      
      try {
        const delivery: WebhookDelivery = JSON.parse(deliveryData);
        const dayBucket = this.getDayBucket(new Date(delivery.createdAt));
        
        // Get or create batch
        if (!batches.has(dayBucket)) {
          batches.set(dayBucket, {
            dayBucket,
            deliveries: [],
            lastUpdated: new Date().toISOString()
          });
        }
        
        const batch = batches.get(dayBucket)!;
        batch.deliveries.push(delivery);
        
        // Delete old individual entry
        await this.env.SYNC_METADATA.delete(key.name);
        migrated++;
      } catch (error) {
        console.error(`Failed to migrate webhook delivery ${key.name}:`, error);
      }
    }
    
    // Save all batches
    const savePromises: Promise<void>[] = [];
    for (const [bucket, batch] of batches) {
      savePromises.push(
        this.env.SYNC_METADATA.put(
          `webhook-batch:${bucket}`,
          JSON.stringify(batch),
          { expirationTtl: 864000 } // 10 days
        )
      );
    }
    
    await Promise.all(savePromises);
    console.log(`Migrated webhook deliveries to ${batches.size} daily batches`);
    return { migrated, batches: batches.size, nextCursor: (deliveryKeys as any).cursor, listComplete: Boolean((deliveryKeys as any).list_complete) };
  }

  /**
   * Clear cache for memory management
   */
  clearCache(): void {
    this.cache.clear();
  }
}
