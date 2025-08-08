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

export class MetricsTracker {
  private env: Env;
  private readonly METRICS_PREFIX = 'metrics:';
  private readonly METRICS_TTL = 86400 * 7; // 7 days retention

  constructor(env: Env) {
    this.env = env;
  }

  async recordMetric(metric: SyncMetric): Promise<void> {
    const key = `${this.METRICS_PREFIX}${metric.type}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      await this.env.SYNC_METADATA.put(
        key,
        JSON.stringify(metric),
        { expirationTtl: this.METRICS_TTL }
      );
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
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
    const metrics: SyncMetric[] = [];
    
    // Fetch all metrics from KV
    const metricsList = await this.env.SYNC_METADATA.list({ prefix: this.METRICS_PREFIX });
    
    // Batch fetch metrics with parallelization
    const fetchPromises = metricsList.keys.map(async (key) => {
      try {
        const data = await this.env.SYNC_METADATA.get(key.name);
        if (data) {
          const metric = JSON.parse(data) as SyncMetric;
          const metricTime = new Date(metric.timestamp).getTime();
          if (metricTime >= cutoffTime) {
            return metric;
          }
        }
      } catch (error) {
        console.error(`Failed to parse metric ${key.name}:`, error);
      }
      return null;
    });
    
    const fetchedMetrics = await Promise.all(fetchPromises);
    metrics.push(...fetchedMetrics.filter((m): m is SyncMetric => m !== null));
    
    // Sort metrics by timestamp
    metrics.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    // Calculate statistics
    const byType: MetricsSummary['byType'] = {};
    const recentErrors: MetricsSummary['recentErrors'] = [];
    const taskStats = {
      totalProcessed: 0,
      created: 0,
      updated: 0,
      completed: 0,
      errors: 0
    };
    
    const allDurations: number[] = [];
    
    for (const metric of metrics) {
      // Initialize type stats if not exists
      if (!byType[metric.type]) {
        byType[metric.type] = {
          count: 0,
          successRate: 0,
          averageDuration: 0,
          totalTasks: 0
        };
      }
      
      const typeStats = byType[metric.type];
      typeStats.count++;
      allDurations.push(metric.duration);
      
      if (metric.success) {
        typeStats.successRate = ((typeStats.successRate * (typeStats.count - 1)) + 1) / typeStats.count;
      } else {
        typeStats.successRate = (typeStats.successRate * (typeStats.count - 1)) / typeStats.count;
        
        // Track recent errors
        if (metric.errorMessage) {
          recentErrors.push({
            timestamp: metric.timestamp,
            type: metric.type,
            message: metric.errorMessage
          });
        }
      }
      
      typeStats.averageDuration = ((typeStats.averageDuration * (typeStats.count - 1)) + metric.duration) / typeStats.count;
      
      // Aggregate task statistics
      if (metric.details) {
        typeStats.totalTasks += metric.details.tasksProcessed || 0;
        taskStats.totalProcessed += metric.details.tasksProcessed || 0;
        taskStats.created += metric.details.created || 0;
        taskStats.updated += metric.details.existing || 0;
        taskStats.completed += metric.details.completed || 0;
        taskStats.errors += metric.details.errors || 0;
      }
    }
    
    // Calculate percentiles
    allDurations.sort((a, b) => a - b);
    const p50 = this.getPercentile(allDurations, 50);
    const p90 = this.getPercentile(allDurations, 90);
    const p99 = this.getPercentile(allDurations, 99);
    
    // Find slowest sync
    const slowestMetric = metrics.reduce((slowest, current) => 
      !slowest || current.duration > slowest.duration ? current : slowest
    , null as SyncMetric | null);
    
    // Keep only last 10 errors
    recentErrors.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    recentErrors.splice(10);
    
    return {
      period: `Last ${hours} hours`,
      totalSyncs: metrics.length,
      successRate: metrics.length > 0 
        ? metrics.filter(m => m.success).length / metrics.length 
        : 0,
      averageDuration: allDurations.length > 0
        ? allDurations.reduce((sum, d) => sum + d, 0) / allDurations.length
        : 0,
      byType,
      recentErrors,
      taskStats,
      performance: {
        p50Duration: p50,
        p90Duration: p90,
        p99Duration: p99,
        slowestSync: slowestMetric ? {
          timestamp: slowestMetric.timestamp,
          type: slowestMetric.type,
          duration: slowestMetric.duration
        } : {
          timestamp: '',
          type: '',
          duration: 0
        }
      }
    };
  }

  private getPercentile(sortedArray: number[], percentile: number): number {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, Math.min(index, sortedArray.length - 1))];
  }

  async cleanupOldMetrics(): Promise<number> {
    const cutoffTime = Date.now() - (this.METRICS_TTL * 1000);
    const metricsList = await this.env.SYNC_METADATA.list({ prefix: this.METRICS_PREFIX });
    let deleted = 0;
    
    for (const key of metricsList.keys) {
      try {
        const data = await this.env.SYNC_METADATA.get(key.name);
        if (data) {
          const metric = JSON.parse(data) as SyncMetric;
          const metricTime = new Date(metric.timestamp).getTime();
          if (metricTime < cutoffTime) {
            await this.env.SYNC_METADATA.delete(key.name);
            deleted++;
          }
        }
      } catch (error) {
        console.error(`Failed to cleanup metric ${key.name}:`, error);
      }
    }
    
    return deleted;
  }
}