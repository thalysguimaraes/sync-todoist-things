// Webhook handlers for different services
import {
  GitHubWebhookEvent,
  NotionWebhookEvent,
  SlackWebhookEvent,
  GenericWebhookEvent,
  WebhookTransformation,
  WebhookConfig,
  AnyWebhookEvent,
  WebhookEvent
} from './types';
import { Env } from '../types';

export class WebhookHandlers {
  constructor(
    private env: Env,
    private config: WebhookConfig
  ) {}

  /**
   * Route webhook events to appropriate handlers
   */
  async handleWebhook(event: AnyWebhookEvent): Promise<WebhookTransformation> {
    try {
      switch (event.source) {
        case 'github':
          return await this.handleGitHubWebhook(event);
        case 'notion':
          return await this.handleNotionWebhook(event);
        case 'slack':
          return await this.handleSlackWebhook(event);
        case 'generic':
          return await this.handleGenericWebhook(event as GenericWebhookEvent);
        case 'todoist':
          return await this.handleTodoistWebhook(event as WebhookEvent);
        default:
          return {
            success: false,
            error: `Unsupported webhook source: ${event.source}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Handle GitHub webhook events (issues, PRs, comments)
   */
  private async handleGitHubWebhook(event: GitHubWebhookEvent): Promise<WebhookTransformation> {
    if (!this.config.sources.github.enabled) {
      return { success: false, error: 'GitHub webhooks are disabled' };
    }

    const { data } = event;
    
    // Filter by repository if configured
    if (this.config.sources.github.repositories?.length) {
      const allowedRepos = this.config.sources.github.repositories;
      if (!allowedRepos.includes(data.repository.full_name)) {
        return { success: false, error: 'Repository not in allowed list' };
      }
    }

    // Filter by event type if configured
    if (this.config.sources.github.events?.length) {
      if (!this.config.sources.github.events.includes(event.type)) {
        return { success: false, error: 'Event type not in allowed list' };
      }
    }

    let thingsTask;
    let metadata;

    switch (event.type) {
      case 'issues':
        if (data.action === 'opened' || data.action === 'reopened') {
          const issue = data.issue!;
          thingsTask = {
            title: `${data.repository.name}#${issue.number}: ${issue.title}`,
            notes: this.buildIssueNotes(issue, data.repository),
            tags: ['github', 'issue', ...issue.labels.map(l => l.name)],
            due: issue.milestone?.due_on || undefined
          };
          metadata = {
            source: 'github',
            originalId: issue.id.toString(),
            url: issue.html_url
          };
        }
        break;

      case 'pull_request':
        if (data.action === 'opened' || data.action === 'reopened') {
          const pr = data.pull_request!;
          thingsTask = {
            title: `${data.repository.name}#${pr.number}: ${pr.title}`,
            notes: this.buildPRNotes(pr, data.repository),
            tags: ['github', 'pull-request']
          };
          metadata = {
            source: 'github',
            originalId: pr.id.toString(),
            url: pr.html_url
          };
        }
        break;

      case 'issue_comment':
        if (data.action === 'created' && data.issue) {
          const issue = data.issue!;
          const comment = data.comment!;
          thingsTask = {
            title: `Review comment: ${data.repository.name}#${issue.number}`,
            notes: this.buildCommentNotes(comment, issue, data.repository),
            tags: ['github', 'comment']
          };
          metadata = {
            source: 'github',
            originalId: comment.id.toString(),
            url: comment.html_url
          };
        }
        break;

      case 'pull_request_review_comment':
        if (data.action === 'created' && data.pull_request) {
          const pr = data.pull_request!;
          const comment = data.comment!;
          thingsTask = {
            title: `PR Review: ${data.repository.name}#${pr.number}`,
            notes: this.buildCommentNotes(comment, pr, data.repository, true),
            tags: ['github', 'pr-review']
          };
          metadata = {
            source: 'github',
            originalId: comment.id.toString(),
            url: comment.html_url
          };
        }
        break;
    }

    if (!thingsTask) {
      return { success: false, error: 'No task created for this event action' };
    }

    return {
      success: true,
      thingsTask,
      metadata
    };
  }

  /**
   * Handle Notion webhook events
   */
  private async handleNotionWebhook(event: NotionWebhookEvent): Promise<WebhookTransformation> {
    if (!this.config.sources.notion.enabled) {
      return { success: false, error: 'Notion webhooks are disabled' };
    }

    const { data } = event;
    
    // Filter by database if configured
    if (this.config.sources.notion.databases?.length) {
      const parentId = data.parent?.database_id || data.parent?.page_id;
      if (parentId && !this.config.sources.notion.databases.includes(parentId)) {
        return { success: false, error: 'Database not in allowed list' };
      }
    }

    // Extract title from Notion object
    let title = 'Notion Update';
    if (data.title && data.title.length > 0) {
      title = data.title[0].plain_text || title;
    } else if (data.properties?.Name?.title?.[0]?.plain_text) {
      title = data.properties.Name.title[0].plain_text;
    } else if (data.properties?.Title?.title?.[0]?.plain_text) {
      title = data.properties.Title.title[0].plain_text;
    }

    const thingsTask = {
      title: `Notion: ${title}`,
      notes: this.buildNotionNotes(data),
      tags: ['notion', event.type],
      due: data.properties?.Due?.date?.start || undefined
    };

    const metadata = {
      source: 'notion',
      originalId: data.id,
      url: `https://notion.so/${data.id.replace(/-/g, '')}`
    };

    return {
      success: true,
      thingsTask,
      metadata
    };
  }

  /**
   * Handle Slack webhook events
   */
  private async handleSlackWebhook(event: SlackWebhookEvent): Promise<WebhookTransformation> {
    if (!this.config.sources.slack.enabled) {
      return { success: false, error: 'Slack webhooks are disabled' };
    }

    const { data } = event;
    
    // Filter by channel if configured
    if (this.config.sources.slack.channels?.length) {
      const channel = data.item?.channel;
      if (channel && !this.config.sources.slack.channels.includes(channel)) {
        return { success: false, error: 'Channel not in allowed list' };
      }
    }

    let thingsTask;
    let metadata;

    switch (event.type) {
      case 'star_added':
        if (data.item?.message) {
          const message = data.item.message;
          thingsTask = {
            title: `Starred Slack message`,
            notes: this.buildSlackNotes(message, data.item.channel),
            tags: ['slack', 'starred']
          };
          metadata = {
            source: 'slack',
            originalId: message.ts,
            url: `slack://channel?team=&id=${data.item.channel}&message=${message.ts}`
          };
        }
        break;

      case 'reaction_added':
        if (data.item?.message) {
          const message = data.item.message;
          thingsTask = {
            title: `Slack message with reaction`,
            notes: this.buildSlackNotes(message, data.item.channel),
            tags: ['slack', 'reaction']
          };
          metadata = {
            source: 'slack',
            originalId: message.ts,
            url: `slack://channel?team=&id=${data.item.channel}&message=${message.ts}`
          };
        }
        break;
    }

    if (!thingsTask) {
      return { success: false, error: 'No task created for this Slack event' };
    }

    return {
      success: true,
      thingsTask,
      metadata
    };
  }

  /**
   * Handle generic webhook events with transformation rules
   */
  private async handleGenericWebhook(event: GenericWebhookEvent): Promise<WebhookTransformation> {
    if (!this.config.sources.generic.enabled) {
      return { success: false, error: 'Generic webhooks are disabled' };
    }

    const transformRules = this.config.sources.generic.transformRules || [];
    
    // Find matching transformation rule
    for (const rule of transformRules) {
      if (this.matchesCondition(event.data, rule.condition)) {
        const thingsTask = {
          title: this.applyTemplate(rule.transformation.title, event.data),
          notes: rule.transformation.notes ? this.applyTemplate(rule.transformation.notes, event.data) : undefined,
          tags: ['webhook', ...(rule.transformation.tags || [])],
          project: rule.transformation.project
        };

        const metadata = {
          source: 'generic',
          originalId: event.id,
          url: this.extractValue(event.data, 'url') || undefined
        };

        return {
          success: true,
          thingsTask,
          metadata
        };
      }
    }

    return { success: false, error: 'No matching transformation rule found' };
  }

  /**
   * Handle Todoist webhook events (completed/deleted)
   * This does not create Things tasks directly. Instead we enqueue sync requests
   * for the mac agent to apply changes in Things by thingsId.
   */
  private async handleTodoistWebhook(event: WebhookEvent): Promise<WebhookTransformation> {
    // Expect event.data with an array of changes or a single change
    const changes = Array.isArray(event.data) ? event.data : [event.data];
    try {
      for (const change of changes) {
        const kind = change.event_name || change.type || '';
        const todoistId = change.id || change.item_id || change.task_id;
        if (!todoistId) continue;
        // Enqueue request for local agent with minimal payload
        const request = {
          id: `todoist-webhook-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          type: kind.includes('deleted') ? 'todoist_deleted' : kind.includes('completed') ? 'todoist_completed' : 'todoist_event',
          todoistId,
          status: 'pending'
        };
        if (this.env.ENABLE_WEBHOOK_LOGS === 'true') {
          await this.env.SYNC_METADATA.put(`sync-request:${request.id}`, JSON.stringify(request), { expirationTtl: 300 });
        }
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Todoist webhook handling failed' };
    }
  }

  // Helper methods for building task notes
  private buildIssueNotes(issue: any, repository: any): string {
    const assignees = issue.assignees?.map((a: any) => `@${a.login}`).join(', ') || 'Unassigned';
    const labels = issue.labels?.map((l: any) => l.name).join(', ') || 'No labels';
    
    return `**GitHub Issue**

**Repository:** ${repository.full_name}
**Author:** @${issue.user.login}
**Assignees:** ${assignees}
**Labels:** ${labels}
**State:** ${issue.state}

**Description:**
${issue.body || 'No description provided'}

**Link:** ${issue.html_url}`;
  }

  private buildPRNotes(pr: any, repository: any): string {
    return `**GitHub Pull Request**

**Repository:** ${repository.full_name}
**Author:** @${pr.user.login}
**Branch:** ${pr.head.ref} → ${pr.base.ref}
**State:** ${pr.state}

**Description:**
${pr.body || 'No description provided'}

**Link:** ${pr.html_url}`;
  }

  private buildCommentNotes(comment: any, parent: any, repository: any, isPR = false): string {
    const type = isPR ? 'Pull Request' : 'Issue';
    return `**GitHub ${type} Comment**

**Repository:** ${repository.full_name}
**${type}:** ${parent.title}
**Comment by:** @${comment.user.login}

**Comment:**
${comment.body}

**Link:** ${comment.html_url}`;
  }

  private buildNotionNotes(data: any): string {
    const properties = Object.entries(data.properties || {})
      .map(([key, value]: [string, any]) => {
        const content = this.extractNotionProperty(value);
        return content ? `**${key}:** ${content}` : null;
      })
      .filter(Boolean)
      .join('\n');

    return `**Notion Object**

**ID:** ${data.id}
**Type:** ${data.object}
**Created:** ${data.created_time}
**Last edited:** ${data.last_edited_time}

${properties}`;
  }

  private buildSlackNotes(message: any, channel: string): string {
    return `**Slack Message**

**Channel:** <#${channel}>
**User:** <@${message.user}>
**Time:** ${new Date(parseFloat(message.ts) * 1000).toISOString()}

**Message:**
${message.text}`;
  }

  // Helper methods for generic webhooks
  private matchesCondition(data: any, condition: any): boolean {
    const value = this.extractValue(data, condition.field);
    
    switch (condition.operator) {
      case 'equals':
        return value === condition.value;
      case 'contains':
        return typeof value === 'string' && value.includes(condition.value);
      case 'startsWith':
        return typeof value === 'string' && value.startsWith(condition.value);
      case 'exists':
        return value !== undefined && value !== null;
      default:
        return false;
    }
  }

  private applyTemplate(template: string, data: any): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (match, field) => {
      return this.extractValue(data, field) || match;
    });
  }

  private extractValue(data: any, path: string): any {
    return path.split('.').reduce((obj, key) => obj?.[key], data);
  }

  private extractNotionProperty(property: any): string | null {
    if (property.type === 'title' || property.type === 'rich_text') {
      return property[property.type]?.[0]?.plain_text;
    }
    if (property.type === 'select') {
      return property.select?.name;
    }
    if (property.type === 'date') {
      return property.date?.start;
    }
    if (property.type === 'checkbox') {
      return property.checkbox ? 'Yes' : 'No';
    }
    if (property.type === 'number') {
      return property.number?.toString();
    }
    return null;
  }
}