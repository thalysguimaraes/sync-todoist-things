import { Env } from './types';
import type { SyncMetric } from './metrics';

export interface AggregatedMetrics {
  hourBucket: number;
  counters: Record<string, number>;
  durations: Record<string, number[]>;
  errors: Array<{ type: string; message: string; timestamp: string }>;
  lastUpdated: string;
}

export interface MetricsSummary {
  totalOperations: number;
  operationsByType: Record<string, number>;
  averageDurations: Record<string, number>;
  errorRate: number;
  successRate: number;
  periodStart: Date;
  periodEnd: Date;
}

export class MetricsAggregator {
  private env: Env;
  private pendingMetrics: Map<number, AggregatedMetrics> = new Map();
  private cache: Map<number, AggregatedMetrics> = new Map();
  
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Migrate pre-aggregation metric entries (metrics:* except metrics:hour:*)
   * into hourly buckets, then delete originals. Safe to re-run.
   */
  async migrateExistingMetrics(keepOriginals: boolean = true): Promise<{ migrated: number; deleted: number; buckets: number; bucketKeys: string[] }> {
    const allMetricKeys = await this.env.SYNC_METADATA.list({ prefix: 'metrics:' });
    const individual = allMetricKeys.keys.filter(k => !k.name.startsWith('metrics:hour:'));

    let migrated = 0;
    const touchedBuckets = new Set<number>();

    for (const key of individual) {
      try {
        const raw = await this.env.SYNC_METADATA.get(key.name);
        if (!raw) continue;

        // Best-effort parse of historical metric entries
        const entry: any = JSON.parse(raw);
        const timestampStr: string = entry.timestamp || entry.time || new Date().toISOString();
        const type: string = entry.type || 'unknown';
        const duration: number | undefined = typeof entry.duration === 'number' ? entry.duration : undefined;
        const success: boolean = typeof entry.success === 'boolean' ? entry.success : true;
        const error: string | undefined = entry.errorMessage || entry.error;

        const hourBucket = this.getHourBucket(new Date(timestampStr));
        let bucketData = await this.loadOrCreateBucket(hourBucket);
        touchedBuckets.add(hourBucket);

        // Update counters and durations
        bucketData.counters[type] = (bucketData.counters[type] || 0) + 1;
        if (duration !== undefined) {
          if (!bucketData.durations[type]) bucketData.durations[type] = [];
          bucketData.durations[type].push(duration);
        }
        if (!success && error) {
          bucketData.errors.push({ type, message: error, timestamp: timestampStr });
        }
        bucketData.lastUpdated = new Date().toISOString();

        // Stage for write
        this.pendingMetrics.set(hourBucket, bucketData);

        // Optionally keep originals for safe rollback window
        if (!keepOriginals) {
          await this.env.SYNC_METADATA.delete(key.name);
        }
        migrated++;
      } catch (e) {
        // Skip malformed entries but continue
        console.error('Failed to migrate metric', key.name, e);
      }
    }

    // Persist all updated buckets
    await this.flush();

    return {
      migrated,
      deleted: keepOriginals ? 0 : migrated,
      buckets: touchedBuckets.size,
      bucketKeys: Array.from(touchedBuckets).map(b => `metrics:hour:${b}`)
    };
  }

  /**
   * Paginated migration of metrics keys. Use this to avoid subrequest limits.
   */
  async migrateExistingMetricsPage(options?: {
    keepOriginals?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<{
    migrated: number;
    deleted: number;
    buckets: number;
    bucketKeys: string[];
    nextCursor?: string;
    listComplete: boolean;
  }> {
    const keepOriginals = options?.keepOriginals !== undefined ? options.keepOriginals : true;
    const limit = options?.limit || 1000;
    const cursor = options?.cursor;

    const listed = await this.env.SYNC_METADATA.list({ prefix: 'metrics:', limit, cursor } as any);
    const individual = listed.keys.filter((k: any) => !k.name.startsWith('metrics:hour:'));

    let migrated = 0;
    const touchedBuckets = new Set<number>();

    for (const key of individual) {
      try {
        const raw = await this.env.SYNC_METADATA.get(key.name);
        if (!raw) continue;

        const entry: any = JSON.parse(raw);
        const timestampStr: string = entry.timestamp || entry.time || new Date().toISOString();
        const type: string = entry.type || 'unknown';
        const duration: number | undefined = typeof entry.duration === 'number' ? entry.duration : undefined;
        const success: boolean = typeof entry.success === 'boolean' ? entry.success : true;
        const error: string | undefined = entry.errorMessage || entry.error;

        const hourBucket = this.getHourBucket(new Date(timestampStr));
        let bucketData = await this.loadOrCreateBucket(hourBucket);
        touchedBuckets.add(hourBucket);

        bucketData.counters[type] = (bucketData.counters[type] || 0) + 1;
        if (duration !== undefined) {
          if (!bucketData.durations[type]) bucketData.durations[type] = [];
          bucketData.durations[type].push(duration);
        }
        if (!success && error) {
          bucketData.errors.push({ type, message: error, timestamp: timestampStr });
        }
        bucketData.lastUpdated = new Date().toISOString();

        this.pendingMetrics.set(hourBucket, bucketData);

        if (!keepOriginals) {
          await this.env.SYNC_METADATA.delete(key.name);
        }
        migrated++;
      } catch (e) {
        console.error('Failed to migrate metric', key.name, e);
      }
    }

    await this.flush();

    return {
      migrated,
      deleted: keepOriginals ? 0 : migrated,
      buckets: touchedBuckets.size,
      bucketKeys: Array.from(touchedBuckets).map(b => `metrics:hour:${b}`),
      nextCursor: (listed as any).cursor,
      listComplete: Boolean((listed as any).list_complete)
    };
  }

  /**
   * Get the current hour bucket
   */
  private getHourBucket(timestamp?: Date): number {
    const time = timestamp || new Date();
    return Math.floor(time.getTime() / 3600000); // Hour buckets
  }

  /**
   * Get the current day bucket
   */
  private getDayBucket(timestamp?: Date): number {
    const time = timestamp || new Date();
    return Math.floor(time.getTime() / 86400000); // Day buckets
  }

  /**
   * Record a metric (aggregated in memory)
   */
  async recordMetric(metric: SyncMetric): Promise<void> {
    const hourBucket = this.getHourBucket(new Date(metric.timestamp));
    
    // Get or create aggregated metrics for this hour
    let aggregated = this.pendingMetrics.get(hourBucket);
    if (!aggregated) {
      aggregated = await this.loadOrCreateBucket(hourBucket);
    }

    // Update counters
    if (!aggregated.counters[metric.type]) {
      aggregated.counters[metric.type] = 0;
    }
    aggregated.counters[metric.type]++;

    // Update durations
    if (metric.duration) {
      if (!aggregated.durations[metric.type]) {
        aggregated.durations[metric.type] = [];
      }
      aggregated.durations[metric.type].push(metric.duration);
    }

    // Record errors
    if (!metric.success && metric.error) {
      aggregated.errors.push({
        type: metric.type,
        message: metric.error,
        timestamp: metric.timestamp
      });
    }

    aggregated.lastUpdated = new Date().toISOString();
    this.pendingMetrics.set(hourBucket, aggregated);
  }

  /**
   * Load or create a bucket
   */
  private async loadOrCreateBucket(hourBucket: number): Promise<AggregatedMetrics> {
    // Check cache
    if (this.cache.has(hourBucket)) {
      return this.cache.get(hourBucket)!;
    }

    // Load from KV
    const key = `metrics:hour:${hourBucket}`;
    const stored = await this.env.SYNC_METADATA.get(key);
    
    if (stored) {
      const metrics = JSON.parse(stored);
      this.cache.set(hourBucket, metrics);
      return metrics;
    }

    // Create new bucket
    return {
      hourBucket,
      counters: {},
      durations: {},
      errors: [],
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Flush pending metrics to KV
   */
  async flush(): Promise<void> {
    const writePromises: Promise<void>[] = [];

    for (const [bucket, metrics] of this.pendingMetrics) {
      const key = `metrics:hour:${bucket}`;
      
      writePromises.push(
        this.env.SYNC_METADATA.put(
          key,
          JSON.stringify(metrics),
          { expirationTtl: 604800 } // 7 days TTL
        ).then(() => {
          this.cache.set(bucket, metrics);
        })
      );
    }

    await Promise.all(writePromises);
    this.pendingMetrics.clear();
  }

  /**
   * Get metrics summary for a time range
   */
  async getMetricsSummary(startTime: Date, endTime: Date): Promise<MetricsSummary> {
    const startBucket = this.getHourBucket(startTime);
    const endBucket = this.getHourBucket(endTime);
    
    const counters: Record<string, number> = {};
    const durations: Record<string, number[]> = {};
    const errors: Array<any> = [];
    
    // Load all buckets in range
    for (let bucket = startBucket; bucket <= endBucket; bucket++) {
      const metrics = await this.loadOrCreateBucket(bucket);
      
      // Aggregate counters
      for (const [type, count] of Object.entries(metrics.counters)) {
        counters[type] = (counters[type] || 0) + count;
      }
      
      // Aggregate durations
      for (const [type, durs] of Object.entries(metrics.durations)) {
        if (!durations[type]) durations[type] = [];
        durations[type].push(...durs);
      }
      
      // Collect errors
      errors.push(...metrics.errors);
    }

    // Calculate averages
    const averageDurations: Record<string, number> = {};
    for (const [type, durs] of Object.entries(durations)) {
      if (durs.length > 0) {
        averageDurations[type] = durs.reduce((a, b) => a + b, 0) / durs.length;
      }
    }

    // Calculate rates
    const totalOperations = Object.values(counters).reduce((a, b) => a + b, 0);
    const errorRate = errors.length / Math.max(totalOperations, 1);
    const successRate = 1 - errorRate;

    return {
      totalOperations,
      operationsByType: counters,
      averageDurations,
      errorRate,
      successRate,
      periodStart: startTime,
      periodEnd: endTime
    };
  }

  /**
   * Get recent metrics (last N hours)
   */
  async getRecentMetrics(hours: number = 24): Promise<MetricsSummary> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - hours * 3600000);
    return this.getMetricsSummary(startTime, endTime);
  }

  /**
   * Clean up old metrics
   */
  async cleanupOldMetrics(daysToKeep: number = 7): Promise<number> {
    const cutoffBucket = this.getHourBucket(
      new Date(Date.now() - daysToKeep * 86400000)
    );
    
    // List all metric keys
    const metricsKeys = await this.env.SYNC_METADATA.list({ prefix: 'metrics:hour:' });
    let deletedCount = 0;
    
    const deletePromises: Promise<void>[] = [];
    for (const key of metricsKeys.keys) {
      const bucket = parseInt(key.name.replace('metrics:hour:', ''));
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
   * Get daily aggregates for reporting
   */
  async getDailyAggregates(days: number = 7): Promise<Array<{
    date: string;
    metrics: MetricsSummary;
  }>> {
    const results = [];
    const now = new Date();
    
    for (let i = 0; i < days; i++) {
      const dayStart = new Date(now);
      dayStart.setDate(dayStart.getDate() - i);
      dayStart.setHours(0, 0, 0, 0);
      
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);
      
      const summary = await this.getMetricsSummary(dayStart, dayEnd);
      results.push({
        date: dayStart.toISOString().split('T')[0],
        metrics: summary
      });
    }
    
    return results;
  }

  /**
   * Clear cache for memory management
   */
  clearCache(): void {
    this.cache.clear();
  }
}
