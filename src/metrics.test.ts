import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MetricsTracker, SyncMetric, MetricsSummary } from './metrics';
import { Env } from './types';

describe('MetricsTracker', () => {
  let mockEnv: Env;
  let metrics: MetricsTracker;
  let kvStore: Map<string, { value: string; expiry?: number }>;

  beforeEach(() => {
    kvStore = new Map();
    
    mockEnv = {
      TODOIST_API_TOKEN: 'test_token',
      REPAIR_AUTH_TOKEN: 'repair_token',
      SYNC_METADATA: {
        get: vi.fn(async (key: string) => {
          const item = kvStore.get(key);
          return item ? item.value : null;
        }),
        put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
          kvStore.set(key, { 
            value, 
            expiry: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined 
          });
        }),
        delete: vi.fn(async (key: string) => {
          kvStore.delete(key);
        }),
        list: vi.fn(async ({ prefix }: { prefix: string }) => {
          const keys = Array.from(kvStore.keys())
            .filter(k => k.startsWith(prefix))
            .map(name => ({ name }));
          return { keys };
        })
      }
    } as Env;

    metrics = new MetricsTracker(mockEnv);
  });

  describe('recordMetric', () => {
    it('should aggregate metrics under daily key', async () => {
      const metric: SyncMetric = {
        timestamp: new Date().toISOString(),
        type: 'inbox_fetch',
        success: true,
        duration: 150,
        details: {
          tasksProcessed: 10
        }
      };

      await metrics.recordMetric(metric);

      const dateKey = new Date().toISOString().split('T')[0];
      const stored = kvStore.get(`metrics:daily:${dateKey}`);
      expect(stored).toBeDefined();
      const record = JSON.parse(stored!.value);
      expect(record.byType['inbox_fetch'].count).toBe(1);
    });

    it('should store metric with TTL', async () => {
      const metric: SyncMetric = {
        timestamp: new Date().toISOString(),
        type: 'things_sync',
        success: true,
        duration: 500,
        details: {
          created: 5,
          existing: 3,
          errors: 0
        }
      };

      await metrics.recordMetric(metric);

      const dateKey = new Date().toISOString().split('T')[0];
      const storedItem = kvStore.get(`metrics:daily:${dateKey}`);
      expect(storedItem?.expiry).toBeDefined();
    });
  });

  describe('trackSync', () => {
    it('should track successful operation', async () => {
      const result = await metrics.trackSync(
        'inbox_fetch',
        async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          return { tasks: 5 };
        },
        (result) => ({ tasksProcessed: result.tasks })
      );

      expect(result).toEqual({ tasks: 5 });

      const dateKey = new Date().toISOString().split('T')[0];
      const stored = kvStore.get(`metrics:daily:${dateKey}`);
      expect(stored).toBeDefined();
    });

    it('should track failed operation', async () => {
      await expect(
        metrics.trackSync(
          'things_sync',
          async () => {
            throw new Error('Network error');
          }
        )
      ).rejects.toThrow('Network error');

      const dateKey = new Date().toISOString().split('T')[0];
      const stored = kvStore.get(`metrics:daily:${dateKey}`);
      expect(stored).toBeDefined();
      const record = JSON.parse(stored!.value);
      expect(record.byType['things_sync'].errors).toBe(1);
    });
  });

  describe('getMetricsSummary', () => {
    beforeEach(async () => {
      // Add test metrics
      const now = Date.now();
      const metricsData: SyncMetric[] = [
        {
          timestamp: new Date(now - 3600000).toISOString(),
          type: 'inbox_fetch',
          success: true,
          duration: 100,
          details: { tasksProcessed: 10 }
        },
        {
          timestamp: new Date(now - 1800000).toISOString(),
          type: 'things_sync',
          success: true,
          duration: 200,
          details: { created: 5, existing: 2, errors: 0 }
        },
        {
          timestamp: new Date(now - 900000).toISOString(),
          type: 'things_sync',
          success: false,
          duration: 50,
          details: { errors: 1 },
          errorMessage: 'Test error'
        },
        {
          timestamp: new Date(now - 300000).toISOString(),
          type: 'completed_sync',
          success: true,
          duration: 150,
          details: { completed: 3 }
        }
      ];

      for (const metric of metricsData) {
        await metrics.recordMetric(metric);
      }
    });

    it('should calculate correct summary statistics', async () => {
      const summary = await metrics.getMetricsSummary(24);

      expect(summary.totalSyncs).toBe(4);
      expect(summary.successRate).toBe(0.75); // 3 out of 4 successful
      expect(summary.period).toBe('Last 24 hours');
    });

    it('should group metrics by type', async () => {
      const summary = await metrics.getMetricsSummary(24);

      expect(summary.byType['inbox_fetch']).toBeDefined();
      expect(summary.byType['inbox_fetch'].count).toBe(1);
      expect(summary.byType['inbox_fetch'].successRate).toBe(1);

      expect(summary.byType['things_sync']).toBeDefined();
      expect(summary.byType['things_sync'].count).toBe(2);
      expect(summary.byType['things_sync'].successRate).toBe(0.5); // 1 success, 1 failure
    });

    it('should track recent errors', async () => {
      const summary = await metrics.getMetricsSummary(24);

      expect(summary.recentErrors).toHaveLength(1);
      expect(summary.recentErrors[0].type).toBe('things_sync');
      expect(summary.recentErrors[0].message).toBe('Test error');
    });

    it('should calculate performance percentiles', async () => {
      const summary = await metrics.getMetricsSummary(24);

      expect(summary.performance.p50Duration).toBeGreaterThan(0);
      expect(summary.performance.p90Duration).toBeGreaterThan(0);
      expect(summary.performance.p99Duration).toBeGreaterThan(0);
      expect(summary.performance.slowestSync.duration).toBe(200);
    });

    it('should filter metrics by time window', async () => {
      // Add an old metric (25 hours ago)
      const oldMetric: SyncMetric = {
        timestamp: new Date(Date.now() - 90000000).toISOString(),
        type: 'inbox_fetch',
        success: true,
        duration: 100,
        details: { tasksProcessed: 5 }
      };

      await metrics.recordMetric(oldMetric);

      const summary = await metrics.getMetricsSummary(24);
      expect(summary.totalSyncs).toBe(4);
    });
  });

  describe('cleanupOldMetrics', () => {
    it('should delete metrics older than TTL', async () => {
      const now = Date.now();
      
      // Add metrics of different ages
      const recentDate = new Date(now - 86400000).toISOString().split('T')[0];
      const oldDate = new Date(now - 86400000 * 8).toISOString().split('T')[0];

      kvStore.set(`metrics:daily:${recentDate}`, { value: JSON.stringify({ date: recentDate, byType: {}, recentErrors: [], slowestSync: { timestamp: '', type: '', duration: 0 } }) });
      kvStore.set(`metrics:daily:${oldDate}`, { value: JSON.stringify({ date: oldDate, byType: {}, recentErrors: [], slowestSync: { timestamp: '', type: '', duration: 0 } }) });

      const deleted = await metrics.cleanupOldMetrics();

      expect(deleted).toBe(1);
      expect(kvStore.has(`metrics:daily:${recentDate}`)).toBe(true);
      expect(kvStore.has(`metrics:daily:${oldDate}`)).toBe(false);
    });
  });

  describe('getPercentile', () => {
    it('should calculate percentiles correctly', () => {
      const tracker = new MetricsTracker(mockEnv);
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      
      // Access private method through reflection for testing
      const getPercentile = (tracker as any).getPercentile.bind(tracker);
      
      expect(getPercentile(values, 50)).toBe(50);
      expect(getPercentile(values, 90)).toBe(90);
      expect(getPercentile(values, 100)).toBe(100);
    });

    it('should handle empty array', () => {
      const tracker = new MetricsTracker(mockEnv);
      const getPercentile = (tracker as any).getPercentile.bind(tracker);
      
      expect(getPercentile([], 50)).toBe(0);
    });
  });
});