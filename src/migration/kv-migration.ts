import { Env } from '../types';
import { MobileBatchManager } from '../mobile-batch-manager';
import { MetricsAggregator } from '../metrics-aggregator';
import { WebhookBatchManager } from '../webhook-batch-manager';

export interface MigrationResult {
  success: boolean;
  migratedItems: number;
  deletedItems: number;
  errors: string[];
  duration: number;
  details: Record<string, any>;
}

export class KVMigrationManager {
  private env: Env;
  
  constructor(env: Env) {
    this.env = env;
  }

  /**
   * Run all migrations to optimize KV usage
   */
  async runFullMigration(): Promise<MigrationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let totalMigrated = 0;
    let totalDeleted = 0;
    const details: Record<string, any> = {};

    console.log('Starting full KV migration...');

    // 1. Migrate mobile mappings
    try {
      const mobileResult = await this.migrateMobileMappings();
      totalMigrated += mobileResult.migrated;
      totalDeleted += mobileResult.deleted;
      details.mobile = mobileResult;
      console.log(`Mobile migration complete: ${mobileResult.migrated} migrated, ${mobileResult.deleted} deleted`);
    } catch (error) {
      const msg = `Mobile migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(msg);
      console.error(msg);
    }

    // 2. Migrate metrics
    try {
      const metricsResult = await this.migrateMetrics();
      totalMigrated += metricsResult.migrated;
      totalDeleted += metricsResult.deleted;
      details.metrics = metricsResult;
      console.log(`Metrics migration complete: ${metricsResult.migrated} migrated, ${metricsResult.deleted} deleted`);
    } catch (error) {
      const msg = `Metrics migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(msg);
      console.error(msg);
    }

    // 3. Migrate webhook deliveries
    try {
      const webhookResult = await this.migrateWebhookDeliveries();
      totalMigrated += webhookResult.migrated;
      totalDeleted += webhookResult.deleted;
      details.webhooks = webhookResult;
      console.log(`Webhook migration complete: ${webhookResult.migrated} migrated, ${webhookResult.deleted} deleted`);
    } catch (error) {
      const msg = `Webhook migration failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(msg);
      console.error(msg);
    }

    // 4. Clean up legacy mappings
    try {
      const legacyResult = await this.cleanupLegacyMappings();
      totalDeleted += legacyResult.deleted;
      details.legacy = legacyResult;
      console.log(`Legacy cleanup complete: ${legacyResult.deleted} deleted`);
    } catch (error) {
      const msg = `Legacy cleanup failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
      errors.push(msg);
      console.error(msg);
    }

    const duration = Date.now() - startTime;
    
    return {
      success: errors.length === 0,
      migratedItems: totalMigrated,
      deletedItems: totalDeleted,
      errors,
      duration,
      details
    };
  }

  /**
   * Migrate mobile mappings to batch format
   */
  private async migrateMobileMappings(): Promise<{ migrated: number; deleted: number; devices: string[] }> {
    const mobileBatch = new MobileBatchManager(this.env);
    const deviceIds = new Set<string>();
    let migrated = 0;
    let deleted = 0;

    // Find all mobile mapping keys
    const mobileKeys = await this.env.SYNC_METADATA.list({ prefix: 'mobile-mapping:' });
    
    for (const key of mobileKeys.keys) {
      const parts = key.name.split(':');
      if (parts.length === 3) {
        const deviceId = parts[1];
        deviceIds.add(deviceId);
      }
    }

    // Migrate each device's mappings
    for (const deviceId of deviceIds) {
      const migrationResult = await mobileBatch.migrateDeviceData(deviceId);
      const deviceKeys = mobileKeys.keys.filter(k => k.name.includes(`:${deviceId}:`));
      migrated += deviceKeys.length;
      deleted += deviceKeys.length;
    }

    return {
      migrated,
      deleted,
      devices: Array.from(deviceIds)
    };
  }

  /**
   * Migrate metrics to aggregated format
   */
  private async migrateMetrics(): Promise<{ migrated: number; deleted: number; buckets: number }> {
    const metricsAggregator = new MetricsAggregator(this.env);
    let cursor: string | undefined = undefined;
    let migrated = 0;
    let buckets = 0;
    do {
      const page = await metricsAggregator.migrateExistingMetricsPage({ keepOriginals: true, limit: 500, cursor });
      migrated += page.migrated;
      buckets += page.buckets;
      cursor = page.nextCursor;
      // Yield between pages by flushing (already done) and proceed
    } while (cursor);
    return { migrated, deleted: 0, buckets };
  }

  /**
   * Migrate webhook deliveries to batch format
   */
  private async migrateWebhookDeliveries(): Promise<{ migrated: number; deleted: number; batches: number }> {
    const webhookBatch = new WebhookBatchManager(this.env);
    let cursor: string | undefined = undefined;
    let migrated = 0;
    let batches = 0;
    do {
      const page = await webhookBatch.migrateExistingDeliveries({ limit: 500, cursor });
      migrated += page.migrated;
      batches += page.batches; // overcounts between pages but OK for estimate
      cursor = page.nextCursor;
    } while (cursor);
    // Deleted equals migrated because page migrates and deletes originals
    return { migrated, deleted: migrated, batches };
  }

  /**
   * Clean up legacy mapping keys
   */
  private async cleanupLegacyMappings(aggressive: boolean = false): Promise<{ deleted: number; patterns: string[] }> {
    let deleted = 0;
    // Be conservative by default: do NOT delete mapping/hash keys unless explicitly requested
    const patterns = aggressive
      ? ['mapping:', 'hash:', 'sync-request:', 'sync-response:']
      : ['mobile-mapping:', 'webhook-delivery:', 'sync-request:', 'sync-response:'];
    
    for (const pattern of patterns) {
      // Page through keys to avoid subrequest spikes
      let cursor: string | undefined = undefined;
      do {
        const page = await this.env.SYNC_METADATA.list({ prefix: pattern, limit: 500, cursor } as any);
        for (const key of page.keys) {
          await this.env.SYNC_METADATA.delete(key.name);
          deleted++;
        }
        cursor = (page as any).cursor;
      } while (cursor);
    }
    
    return {
      deleted,
      patterns
    };
  }

  /**
   * Estimate KV operation reduction
   */
  async estimateReduction(): Promise<{
    current: { reads: number; writes: number; lists: number; deletes: number };
    projected: { reads: number; writes: number; lists: number; deletes: number };
    reduction: { reads: string; writes: string; lists: string; deletes: string };
  }> {
    // Count current individual keys
    const mobileKeys = await this.env.SYNC_METADATA.list({ prefix: 'mobile-mapping:' });
    const metricsKeys = await this.env.SYNC_METADATA.list({ prefix: 'metrics:' });
    const webhookKeys = await this.env.SYNC_METADATA.list({ prefix: 'webhook-delivery:' });
    const mappingKeys = await this.env.SYNC_METADATA.list({ prefix: 'mapping:' });
    const hashKeys = await this.env.SYNC_METADATA.list({ prefix: 'hash:' });
    
    const individualMetrics = metricsKeys.keys.filter(k => !k.name.includes(':hour:'));
    const totalIndividualKeys = 
      mobileKeys.keys.length + 
      individualMetrics.length + 
      webhookKeys.keys.length +
      mappingKeys.keys.length +
      hashKeys.keys.length;

    // Estimate current operations (per day)
    const current = {
      reads: totalIndividualKeys * 10, // Assume 10 reads per key per day
      writes: totalIndividualKeys * 2,  // Assume 2 writes per key per day
      lists: 50 * 12,  // Assume 50 list operations per hour
      deletes: totalIndividualKeys * 0.1 // Assume 10% deletion rate
    };

    // Estimate after optimization
    const projected = {
      reads: Math.floor(current.reads * 0.15), // 85% reduction
      writes: Math.floor(current.writes * 0.06), // 94% reduction
      lists: Math.floor(current.lists * 0.02), // 98% reduction
      deletes: Math.floor(current.deletes * 0.05) // 95% reduction
    };

    // Calculate reduction percentages
    const reduction = {
      reads: `${Math.round((1 - projected.reads / current.reads) * 100)}%`,
      writes: `${Math.round((1 - projected.writes / current.writes) * 100)}%`,
      lists: `${Math.round((1 - projected.lists / current.lists) * 100)}%`,
      deletes: `${Math.round((1 - projected.deletes / current.deletes) * 100)}%`
    };

    return {
      current,
      projected,
      reduction
    };
  }

  /**
   * Verify migration success
   */
  async verifyMigration(): Promise<{
    success: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check for remaining individual keys
    const checks = [
      { prefix: 'mobile-mapping:', name: 'Mobile mappings' },
      { prefix: 'webhook-delivery:', name: 'Webhook deliveries' },
      { prefix: 'mapping:', name: 'Legacy mappings' },
      { prefix: 'hash:', name: 'Hash mappings' }
    ];

    for (const check of checks) {
      const keys = await this.env.SYNC_METADATA.list({ prefix: check.prefix, limit: 1 });
      if (keys.keys.length > 0) {
        issues.push(`Found remaining ${check.name} keys`);
        recommendations.push(`Run migration for ${check.name}`);
      }
    }

    // Check for batch keys
    const batchChecks = [
      { prefix: 'mobile-batch:', name: 'Mobile batches' },
      { prefix: 'metrics:hour:', name: 'Metrics buckets' },
      { prefix: 'webhook-batch:', name: 'Webhook batches' },
      { prefix: 'sync-state:batch', name: 'Sync batch state' }
    ];

    for (const check of batchChecks) {
      const keys = await this.env.SYNC_METADATA.list({ prefix: check.prefix, limit: 1 });
      if (keys.keys.length === 0 && check.prefix !== 'sync-state:batch') {
        issues.push(`No ${check.name} found`);
        recommendations.push(`Verify ${check.name} migration`);
      }
    }

    // Special check for sync-state:batch
    const batchState = await this.env.SYNC_METADATA.get('sync-state:batch');
    if (!batchState) {
      issues.push('No sync batch state found');
      recommendations.push('Initialize batch sync state');
    }

    return {
      success: issues.length === 0,
      issues,
      recommendations
    };
  }
}
