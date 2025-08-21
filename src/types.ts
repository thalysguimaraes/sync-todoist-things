export interface Env {
  TODOIST_API_TOKEN: string;
  TODOIST_API_URL: string;
  SYNC_METADATA: KVNamespace;
  REPAIR_AUTH_TOKEN?: string;
  ENABLE_WEBHOOK_LOGS?: string;
}

export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

export interface TodoistTask {
  id: string;
  project_id: string;
  content: string;
  description: string;
  priority: number;
  due?: {
    date: string;
    datetime?: string;
    string: string;
    lang: string;
    is_recurring: boolean;
  };
  labels: string[];
  created_at: string;
  creator_id: string;
  assignee_id?: string;
  assigner_id?: string;
  comment_count: number;
  is_completed: boolean;
  url: string;
}

export interface TodoistProject {
  id: string;
  name: string;
  color: string;
  parent_id?: string;
  order: number;
  comment_count: number;
  is_shared: boolean;
  is_favorite: boolean;
  is_inbox_project: boolean;
  is_team_inbox: boolean;
  url: string;
  view_style: string;
}

export interface ThingsTask {
  type: 'to-do';
  attributes: {
    title: string;
    notes?: string;
    when?: string;
    deadline?: string;
    tags?: string[];
    'checklist-items'?: Array<{
      type: 'checklist-item';
      attributes: {
        title: string;
        completed?: boolean;
      };
    }>;
  };
}

export interface ThingsInboxTask {
  id: string;
  title: string;
  notes: string;
  due: string | null;
  tags: string[];
}

export interface SyncMetadata {
  todoistId: string;
  thingsId: string;
  lastSynced: string;
  contentHash?: string;
  robustHash?: string;
  fingerprint?: TaskFingerprint;
}

export interface TaskFingerprint {
  primaryHash: string;
  titleVariations: string[];
  fuzzySearchable: string;
}

export interface TaskMapping {
  todoistId: string;
  thingsId: string;
  fingerprint: TaskFingerprint;
  lastSynced: string;
  source: 'exact' | 'fuzzy' | 'hash' | 'legacy';
  version?: number; // For schema versioning
  // Conflict resolution fields
  todoistModifiedAt?: string;
  thingsModifiedAt?: string;
  lastSyncedContent?: {
    title: string;
    notes?: string;
    due?: string;
    labels?: string[];
  };
}

export interface IdempotencyRecord {
  requestId: string;
  result: any;
  timestamp: string;
  ttl: number; // TTL in seconds from creation
}

export interface SyncState {
  isRunning: boolean;
  startedAt: string;
  lastCompletedAt?: string;
}

export interface CompletedTask {
  thingsId: string;
  completedAt: string;
}

export type ConflictResolutionStrategy = 'todoist_wins' | 'things_wins' | 'newest_wins' | 'merge' | 'manual';

export interface SyncConflict {
  id: string;
  todoistId: string;
  thingsId: string;
  detectedAt: string;
  todoistVersion: {
    title: string;
    notes?: string;
    due?: string;
    labels?: string[];
    modifiedAt?: string;
  };
  thingsVersion: {
    title: string;
    notes?: string;
    due?: string;
    tags?: string[];
    modifiedAt?: string;
  };
  lastSyncedVersion?: {
    title: string;
    notes?: string;
    due?: string;
  };
  suggestedResolution?: ConflictResolutionStrategy;
  resolved: boolean;
}

export interface SyncConfig {
  conflictStrategy: ConflictResolutionStrategy;
  enabledProjects?: string[];
  excludedProjects?: string[];
  enabledTags?: string[];
  excludedTags?: string[];
  autoResolveConflicts: boolean;
  syncInterval?: number;
}

export interface BatchSyncState {
  version: number;
  lastUpdated: string;
  mappings: {
    [fingerprint: string]: TaskMapping;
  };
  todoistIndex: {
    [todoistId: string]: string; // Points to fingerprint
  };
  thingsIndex: {
    [thingsId: string]: string; // Points to fingerprint
  };
  stats?: {
    mappingCount: number;
    migratedLegacyMappings?: number;
    pendingLegacyMigration?: number;
  };
}