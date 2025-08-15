// Webhook event types and interfaces for real-time integrations

export interface WebhookEvent<T = unknown> {
  id: string;
  source: WebhookSource;
  type: string;
  timestamp: string;
  /**
   * Service specific payload. The generic parameter allows
   * consumers to get strong typing for the data structure they
   * expect from the source service.
   */
  data: T;
  signature?: string;
  deliveryId?: string;
}

export type WebhookSource = 'github' | 'notion' | 'slack' | 'generic';

// GitHub webhook events
export interface GitHubWebhookEvent extends WebhookEvent<GitHubEventData> {
  source: 'github';
  type: 'issues' | 'pull_request' | 'issue_comment' | 'pull_request_review_comment';
  data: GitHubEventData;
}

export interface GitHubEventData {
  action: string;
  repository: {
    id: number;
    name: string;
    full_name: string;
    html_url: string;
  };
  issue?: {
    id: number;
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    html_url: string;
    user: {
      login: string;
      avatar_url: string;
    };
    labels: Array<{
      name: string;
      color: string;
    }>;
    assignees: Array<{
      login: string;
    }>;
    milestone: {
      title: string;
      due_on: string | null;
    } | null;
    created_at: string;
    updated_at: string;
  };
  pull_request?: {
    id: number;
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed' | 'merged';
    html_url: string;
    user: {
      login: string;
    };
    head: {
      ref: string;
    };
    base: {
      ref: string;
    };
    created_at: string;
    updated_at: string;
  };
  comment?: {
    id: number;
    body: string;
    html_url: string;
    user: {
      login: string;
    };
    created_at: string;
  };
}

// Notion webhook events
export interface NotionWebhookEvent extends WebhookEvent<NotionEventData> {
  source: 'notion';
  type: 'database' | 'page';
  data: NotionEventData;
}

export interface NotionEventData {
  object: string;
  id: string;
  created_time?: string;
  last_edited_time?: string;
  parent?: {
    type: string;
    database_id?: string;
    page_id?: string;
  };
  properties?: any;
  title?: Array<{
    type: string;
    text?: {
      content: string;
    };
    plain_text: string;
  }>;
}

// Slack webhook events
export interface SlackWebhookEvent extends WebhookEvent<SlackEventData> {
  source: 'slack';
  type: 'star_added' | 'star_removed' | 'message' | 'reaction_added';
  data: SlackEventData;
}

export interface SlackEventData {
  type: string;
  user: string;
  item?: {
    type: string;
    channel: string;
    ts: string;
    message?: {
      text: string;
      user: string;
      ts: string;
    };
  };
  event_ts: string;
}

// Generic webhook events
export interface GenericWebhookEvent<T = Record<string, unknown>>
  extends WebhookEvent<T> {
  source: 'generic';
  type: string;
}

// Helper union of all supported webhook events
export type AnyWebhookEvent =
  | GitHubWebhookEvent
  | NotionWebhookEvent
  | SlackWebhookEvent
  | GenericWebhookEvent;

// Webhook transformation result
export interface WebhookTransformation {
  success: boolean;
  thingsTask?: {
    title: string;
    notes?: string;
    tags?: string[];
    due?: string;
    project?: string;
  };
  error?: string;
  metadata?: {
    source: string;
    originalId: string;
    url?: string;
  };
}

// Webhook configuration
export interface WebhookConfig {
  enabled: boolean;
  sources: {
    github: {
      enabled: boolean;
      secret: string;
      repositories?: string[]; // Filter by specific repos
      events?: string[]; // Filter by event types
    };
    notion: {
      enabled: boolean;
      secret: string;
      databases?: string[]; // Filter by specific databases
    };
    slack: {
      enabled: boolean;
      secret: string;
      channels?: string[]; // Filter by specific channels
    };
    generic: {
      enabled: boolean;
      secret: string;
      transformRules?: WebhookTransformRule[];
    };
  };
  rateLimits: {
    perMinute: number;
    perHour: number;
  };
  retryPolicy: {
    enabled: boolean;
    maxRetries: number;
    backoffMs: number;
  };
}

// Webhook transformation rules for generic webhooks
export interface WebhookTransformRule {
  name: string;
  condition: {
    field: string;
    operator: 'equals' | 'contains' | 'startsWith' | 'exists';
    value?: string;
  };
  transformation: {
    title: string; // Template for task title
    notes?: string; // Template for task notes
    tags?: string[]; // Static or templated tags
    project?: string; // Target project
  };
  template?: {
    [key: string]: string; // Template variables like {{field.path}}
  };
}

// Outbound webhook configuration
export interface OutboundWebhookConfig {
  url: string;
  secret?: string;
  events: OutboundWebhookEvent[];
  enabled: boolean;
  retryPolicy: {
    enabled: boolean;
    maxRetries: number;
    backoffMs: number;
  };
}

export type OutboundWebhookEvent = 
  | 'task_synced' 
  | 'conflict_detected' 
  | 'conflict_resolved' 
  | 'sync_completed' 
  | 'sync_failed';

// Outbound webhook payload
export interface OutboundWebhookPayload {
  event: OutboundWebhookEvent;
  timestamp: string;
  data: {
    source?: 'todoist' | 'things';
    target?: 'todoist' | 'things';
    taskId?: string;
    task?: any;
    conflict?: any;
    error?: string;
    metrics?: any;
  };
  signature?: string;
}

// Webhook delivery status
export interface WebhookDelivery {
  id: string;
  webhookUrl: string;
  event: OutboundWebhookEvent;
  payload: OutboundWebhookPayload;
  status: 'pending' | 'delivered' | 'failed' | 'retrying';
  attempts: number;
  lastAttempt?: string;
  nextAttempt?: string;
  error?: string;
  createdAt: string;
}

// Webhook rate limiting
export interface WebhookRateLimit {
  source: WebhookSource;
  minute: number;
  hour: number;
  resetMinute: number;
  resetHour: number;
}