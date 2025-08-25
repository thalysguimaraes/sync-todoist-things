import { Env } from './types';

export interface SyncMetric {
  timestamp: string;
  type: 'inbox_fetch' | 'things_sync' | 'completed_sync' | 'bulk_sync' | 'mark_synced' | 'webhook_processed' | 'cron_sync' | 'sync_coordination' | 'sync_response';
  success: boolean;
  duration: number;
  details: {
    tasksProcessed?: number;
    created?: number;
    existing?: number;
    errors?: number;
    completed?: number;
    source?: string;
    direction?: string;
    conflictsDetected?: number;
    conflictsResolved?: number;
    eventType?: string;
    deliveryId?: string;
    responseType?: string;
    cronPattern?: string;
    scheduledTime?: string;
    tasksFound?: number;
    requestId?: string;
  };
  errorMessage?: string;
}

export interface MetricsSummary {
  period: string;
  totalSyncs: number;
  successRate: number;
  averageDuration: number;
  byType: {
    [key: string]: {
      count: number;
      successRate: number;
      averageDuration: number;
      totalTasks: number;
    };
  };
  recentErrors: Array<{
    timestamp: string;
    type: string;
    message: string;
  }>;
  taskStats: {
    totalProcessed: number;
    created: number;
    updated: number;
    completed: number;
    errors: number;
  };
  performance: {
    p50Duration: number;
    p90Duration: number;
    p99Duration: number;
    slowestSync: {
      timestamp: string;
      type: string;
      duration: number;
    };
  };
}

interface DailyMetricRecord {
  date: string;
  byType: {
    [key: string]: {
      count: number;
      success: number;
      totalDuration: number;
      tasksProcessed: number;
      created: number;
      updated: number;
      completed: number;
      errors: number;
      durations: number[];
    };
  };
  recentErrors: Array<{ timestamp: string; type: string; message: string }>;
  slowestSync: { timestamp: string; type: string; duration: number };
}

export class MetricsTracker {
  private env: Env;
  private readonly METRICS_PREFIX = 'metrics:daily:';
  private readonly METRICS_TTL = 86400 * 7; // 7 days retention

  constructor(env: Env) {
    this.env = env;
  }

  private getDateKey(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  async recordMetric(metric: SyncMetric): Promise<void> {
    const dateKey = this.getDateKey(new Date(metric.timestamp));
    const key = `${this.METRICS_PREFIX}${dateKey}`;

    try {
      const existing = await this.env.SYNC_METADATA.get(key);
      let record: DailyMetricRecord;

      if (existing) {
        record = JSON.parse(existing) as DailyMetricRecord;
      } else {
        record = {
          date: dateKey,
          byType: {},
          recentErrors: [],
          slowestSync: { timestamp: '', type: '', duration: 0 }
        };
      }

      if (!record.byType[metric.type]) {
        record.byType[metric.type] = {
          count: 0,
          success: 0,
          totalDuration: 0,
          tasksProcessed: 0,
          created: 0,
          updated: 0,
          completed: 0,
          errors: 0,
          durations: []
        };
      }

      const typeStats = record.byType[metric.type];
      typeStats.count++;
      if (metric.success) {
        typeStats.success++;
      } else if (metric.errorMessage) {
        record.recentErrors.unshift({ timestamp: metric.timestamp, type: metric.type, message: metric.errorMessage });
        if (record.recentErrors.length > 10) {
          record.recentErrors.pop();
        }
        typeStats.errors++;
      } else {
        typeStats.errors++;
      }

      typeStats.totalDuration += metric.duration;
      typeStats.tasksProcessed += metric.details.tasksProcessed || 0;
      typeStats.created += metric.details.created || 0;
      typeStats.updated += metric.details.existing || 0;
      typeStats.completed += metric.details.completed || 0;

      typeStats.durations.push(metric.duration);
      if (typeStats.durations.length > 100) {
        typeStats.durations.shift();
      }

      if (metric.duration > record.slowestSync.duration) {
        record.slowestSync = { timestamp: metric.timestamp, type: metric.type, duration: metric.duration };
      }

      await this.env.SYNC_METADATA.put(key, JSON.stringify(record), { expirationTtl: this.METRICS_TTL });
    } catch (error) {
      console.error('Failed to record metric:', error);
    }
  }

  async trackSync<T>(
    type: SyncMetric['type'],
    operation: () => Promise<T>,
    extractDetails?: (result: T) => SyncMetric['details']
  ): Promise<T> {
    const startTime = Date.now();
    let success = false;
    let errorMessage: string | undefined;
    let result: T;

    try {
      result = await operation();
      success = true;
      return result;
    } catch (error) {
      success = false;
      errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw error;
    } finally {
      const duration = Date.now() - startTime;
      const metric: SyncMetric = {
        timestamp: new Date().toISOString(),
        type,
        success,
        duration,
        details: result && extractDetails ? extractDetails(result) : {},
        errorMessage
      };
      
      await this.recordMetric(metric);
    }
  }

  async getMetricsSummary(hours: number = 24): Promise<MetricsSummary> {
    const days = Math.ceil(hours / 24);
    const records: DailyMetricRecord[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today.getTime() - i * 86400000);
      const key = `${this.METRICS_PREFIX}${this.getDateKey(date)}`;
      const data = await this.env.SYNC_METADATA.get(key);
      if (data) {
        records.push(JSON.parse(data) as DailyMetricRecord);
      }
    }

    const byTypeAgg: { [key: string]: { count: number; success: number; totalDuration: number; totalTasks: number; durations: number[] } } = {};
    const recentErrors: MetricsSummary['recentErrors'] = [];
    const taskStats = { totalProcessed: 0, created: 0, updated: 0, completed: 0, errors: 0 };
    const allDurations: number[] = [];
    let totalCount = 0;
    let totalSuccess = 0;
    let totalDuration = 0;
    let slowestSync: { timestamp: string; type: string; duration: number } = { timestamp: '', type: '', duration: 0 };

    for (const record of records) {
      recentErrors.push(...record.recentErrors);
      if (record.slowestSync.duration > slowestSync.duration) {
        slowestSync = record.slowestSync;
      }

      for (const [type, stats] of Object.entries(record.byType)) {
        if (!byTypeAgg[type]) {
          byTypeAgg[type] = { count: 0, success: 0, totalDuration: 0, totalTasks: 0, durations: [] };
        }
        const agg = byTypeAgg[type];
        agg.count += stats.count;
        agg.success += stats.success;
        agg.totalDuration += stats.totalDuration;
        agg.totalTasks += stats.tasksProcessed + stats.created + stats.updated + stats.completed;
        agg.durations.push(...stats.durations);

        totalCount += stats.count;
        totalSuccess += stats.success;
        totalDuration += stats.totalDuration;
        taskStats.totalProcessed += stats.tasksProcessed;
        taskStats.created += stats.created;
        taskStats.updated += stats.updated;
        taskStats.completed += stats.completed;
        taskStats.errors += stats.errors;
        allDurations.push(...stats.durations);
      }
    }

    recentErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    recentErrors.splice(10);

    allDurations.sort((a, b) => a - b);
    const p50 = this.getPercentile(allDurations, 50);
    const p90 = this.getPercentile(allDurations, 90);
    const p99 = this.getPercentile(allDurations, 99);

    const byType: MetricsSummary['byType'] = {};
    for (const [type, agg] of Object.entries(byTypeAgg)) {
      byType[type] = {
        count: agg.count,
        successRate: agg.count ? agg.success / agg.count : 0,
        averageDuration: agg.count ? agg.totalDuration / agg.count : 0,
        totalTasks: agg.totalTasks
      };
    }

    return {
      period: `Last ${hours} hours`,
      totalSyncs: totalCount,
      successRate: totalCount ? totalSuccess / totalCount : 0,
      averageDuration: totalCount ? totalDuration / totalCount : 0,
      byType,
      recentErrors,
      taskStats,
      performance: {
        p50Duration: p50,
        p90Duration: p90,
        p99Duration: p99,
        slowestSync
      }
    };
  }

  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
  }

  async cleanupOldMetrics(): Promise<number> {
    const cutoffDate = new Date(Date.now() - this.METRICS_TTL * 1000);
    const cutoffKey = this.getDateKey(cutoffDate);
    const metricsList = await this.env.SYNC_METADATA.list({ prefix: this.METRICS_PREFIX });
    let deleted = 0;

    for (const key of metricsList.keys) {
      const datePart = key.name.replace(this.METRICS_PREFIX, '');
      if (datePart < cutoffKey) {
        await this.env.SYNC_METADATA.delete(key.name);
        deleted++;
      }
    }

    return deleted;
  }
}