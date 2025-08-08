export interface Env {
  TODOIST_API_TOKEN: string;
  TODOIST_API_URL: string;
  SYNC_METADATA: KVNamespace;
  REPAIR_AUTH_TOKEN?: string;
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