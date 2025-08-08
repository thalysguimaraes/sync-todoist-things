import { SyncConfig, ConflictResolutionStrategy } from './types';

const DEFAULT_CONFIG: SyncConfig = {
  conflictStrategy: 'newest_wins',
  autoResolveConflicts: true,
  syncInterval: 300, // 5 minutes
  enabledProjects: undefined, // All projects by default
  excludedProjects: [],
  enabledTags: undefined, // All tags by default
  excludedTags: ['synced-to-things', 'synced-from-things'] // Exclude sync tags
};

export class ConfigManager {
  private kv: KVNamespace;
  private configKey = 'sync:config';
  private config: SyncConfig;

  constructor(kv: KVNamespace) {
    this.kv = kv;
    this.config = DEFAULT_CONFIG;
  }

  /**
   * Load configuration from KV storage
   */
  async loadConfig(): Promise<SyncConfig> {
    try {
      const stored = await this.kv.get(this.configKey);
      if (stored) {
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
      }
    } catch (error) {
      console.error('Failed to load config:', error);
      this.config = DEFAULT_CONFIG;
    }
    return this.config;
  }

  /**
   * Save configuration to KV storage
   */
  async saveConfig(config: Partial<SyncConfig>): Promise<SyncConfig> {
    this.config = { ...this.config, ...config };
    await this.kv.put(this.configKey, JSON.stringify(this.config));
    return this.config;
  }

  /**
   * Get current configuration
   */
  getConfig(): SyncConfig {
    return this.config;
  }

  /**
   * Update conflict resolution strategy
   */
  async setConflictStrategy(strategy: ConflictResolutionStrategy): Promise<void> {
    await this.saveConfig({ conflictStrategy: strategy });
  }

  /**
   * Check if a project should be synced
   */
  shouldSyncProject(projectId: string, projectName?: string): boolean {
    // If excluded, don't sync
    if (this.config.excludedProjects?.includes(projectId)) {
      return false;
    }
    if (projectName && this.config.excludedProjects?.includes(projectName)) {
      return false;
    }

    // If enabled list exists, only sync if included
    if (this.config.enabledProjects && this.config.enabledProjects.length > 0) {
      return this.config.enabledProjects.includes(projectId) ||
             (projectName ? this.config.enabledProjects.includes(projectName) : false);
    }

    // By default, sync all non-excluded projects
    return true;
  }

  /**
   * Check if a tag should be synced
   */
  shouldSyncTag(tag: string): boolean {
    // If excluded, don't sync
    if (this.config.excludedTags?.includes(tag)) {
      return false;
    }

    // If enabled list exists, only sync if included
    if (this.config.enabledTags && this.config.enabledTags.length > 0) {
      return this.config.enabledTags.includes(tag);
    }

    // By default, sync all non-excluded tags
    return true;
  }

  /**
   * Filter tags for syncing
   */
  filterTags(tags: string[]): string[] {
    return tags.filter(tag => this.shouldSyncTag(tag));
  }

  /**
   * Validate configuration
   */
  validateConfig(config: Partial<SyncConfig>): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate conflict strategy
    if (config.conflictStrategy) {
      const validStrategies: ConflictResolutionStrategy[] = [
        'todoist_wins', 'things_wins', 'newest_wins', 'merge', 'manual'
      ];
      if (!validStrategies.includes(config.conflictStrategy)) {
        errors.push(`Invalid conflict strategy: ${config.conflictStrategy}`);
      }
    }

    // Validate sync interval
    if (config.syncInterval !== undefined) {
      if (config.syncInterval < 60) {
        errors.push('Sync interval must be at least 60 seconds');
      }
      if (config.syncInterval > 3600) {
        errors.push('Sync interval must be less than 1 hour');
      }
    }

    // Check for conflicting project settings
    if (config.enabledProjects && config.excludedProjects) {
      const overlap = config.enabledProjects.filter(p => 
        config.excludedProjects!.includes(p)
      );
      if (overlap.length > 0) {
        errors.push(`Projects cannot be both enabled and excluded: ${overlap.join(', ')}`);
      }
    }

    // Check for conflicting tag settings
    if (config.enabledTags && config.excludedTags) {
      const overlap = config.enabledTags.filter(t => 
        config.excludedTags!.includes(t)
      );
      if (overlap.length > 0) {
        errors.push(`Tags cannot be both enabled and excluded: ${overlap.join(', ')}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Reset to default configuration
   */
  async resetToDefault(): Promise<SyncConfig> {
    this.config = DEFAULT_CONFIG;
    await this.kv.put(this.configKey, JSON.stringify(this.config));
    return this.config;
  }

  /**
   * Export configuration as JSON
   */
  exportConfig(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /**
   * Import configuration from JSON
   */
  async importConfig(jsonString: string): Promise<{ success: boolean; errors?: string[] }> {
    try {
      const parsed = JSON.parse(jsonString);
      const validation = this.validateConfig(parsed);
      
      if (!validation.valid) {
        return { success: false, errors: validation.errors };
      }

      await this.saveConfig(parsed);
      return { success: true };
    } catch (error) {
      return { 
        success: false, 
        errors: [`Invalid JSON: ${error instanceof Error ? error.message : 'Unknown error'}`]
      };
    }
  }
}