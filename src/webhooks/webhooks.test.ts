// Tests for webhook functionality
import { describe, it, expect, beforeEach, expectTypeOf } from 'vitest';
import { WebhookHandlers } from './handlers';
import { WebhookSecurity } from './security';
import {
  WebhookConfig,
  GitHubWebhookEvent,
  NotionWebhookEvent,
  SlackWebhookEvent,
  GenericWebhookEvent,
  GitHubEventData,
  NotionEventData,
  SlackEventData
} from './types';
import { createTestEnvironment } from '../test-helpers';

describe('Webhook Integration Tests', () => {
  let testEnv: ReturnType<typeof createTestEnvironment>;
  let webhookConfig: WebhookConfig;

  beforeEach(() => {
    testEnv = createTestEnvironment();
    webhookConfig = {
      enabled: true,
      sources: {
        github: {
          enabled: true,
          secret: 'test-github-secret',
          repositories: ['test/repo'],
          events: ['issues', 'pull_request']
        },
        notion: {
          enabled: true,
          secret: 'test-notion-secret',
          databases: ['test-db-id']
        },
        slack: {
          enabled: true,
          secret: 'test-slack-secret',
          channels: ['C1234567890']
        },
        generic: {
          enabled: true,
          secret: 'test-generic-secret',
          transformRules: [{
            name: 'Test Rule',
            condition: {
              field: 'type',
              operator: 'equals',
              value: 'test'
            },
            transformation: {
              title: 'Test: {{title}}',
              notes: 'Generated from webhook: {{description}}',
              tags: ['webhook', 'test']
            }
          }]
        }
      },
      rateLimits: {
        perMinute: 60,
        perHour: 1000
      },
      retryPolicy: {
        enabled: true,
        maxRetries: 3,
        backoffMs: 1000
      }
    };
  });

  describe('WebhookSecurity', () => {
    let security: WebhookSecurity;

    beforeEach(() => {
      security = new WebhookSecurity(testEnv.env);
    });

    it('should verify GitHub signature correctly', async () => {
      const payload = '{"action":"opened","number":1}';
      const secret = 'my-secret';
      
      // Compute expected signature using the same method
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
      const expectedSig = Array.from(new Uint8Array(signature))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      
      const isValid = await security.verifySignature(
        'github',
        payload,
        `sha256=${expectedSig}`,
        secret
      );
      
      expect(isValid).toBe(true);
    });

    it('should reject invalid signatures', async () => {
      const payload = '{"action":"opened","number":1}';
      const secret = 'my-secret';
      const invalidSignature = 'sha256=invalid';
      
      const isValid = await security.verifySignature(
        'github',
        payload,
        invalidSignature,
        secret
      );
      
      expect(isValid).toBe(false);
    });

    it('should validate payload structures correctly', async () => {
      const validGitHubPayload = {
        action: 'opened',
        repository: {
          full_name: 'test/repo',
          html_url: 'https://github.com/test/repo'
        }
      };
      
      expect(security.validatePayload('github', validGitHubPayload)).toBe(true);
      expect(security.validatePayload('github', { invalid: 'payload' })).toBe(false);
    });

    it('should handle rate limiting', async () => {
      // First request should be allowed
      const result1 = await security.checkRateLimit('github', 5, 100);
      expect(result1.allowed).toBe(true);
      
      // Subsequent requests within limit should be allowed
      for (let i = 0; i < 4; i++) {
        const result = await security.checkRateLimit('github', 5, 100);
        expect(result.allowed).toBe(true);
      }
      
      // 6th request should be rate limited
      const result2 = await security.checkRateLimit('github', 5, 100);
      expect(result2.allowed).toBe(false);
    });
  });

  describe('WebhookHandlers', () => {
    let handlers: WebhookHandlers;

    beforeEach(() => {
      handlers = new WebhookHandlers(testEnv.env, webhookConfig);
    });

    it('should handle GitHub issue webhook correctly', async () => {
      const githubEvent: GitHubWebhookEvent = {
        id: 'test-github-1',
        source: 'github',
        type: 'issues',
        timestamp: new Date().toISOString(),
        data: {
          action: 'opened',
          repository: {
            id: 123,
            name: 'test-repo',
            full_name: 'test/repo',
            html_url: 'https://github.com/test/repo'
          },
          issue: {
            id: 456,
            number: 1,
            title: 'Test Issue',
            body: 'This is a test issue',
            state: 'open',
            html_url: 'https://github.com/test/repo/issues/1',
            user: {
              login: 'testuser',
              avatar_url: 'https://github.com/testuser.png'
            },
            labels: [{ name: 'bug', color: 'red' }],
            assignees: [{ login: 'assignee1' }],
            milestone: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        }
      };
      expectTypeOf(githubEvent.data).toMatchTypeOf<GitHubEventData>();

      const result = await handlers.handleWebhook(githubEvent);

      expect(result.success).toBe(true);
      expect(result.thingsTask).toBeDefined();
      expect(result.thingsTask?.title).toBe('test-repo#1: Test Issue');
      expect(result.thingsTask?.tags).toContain('github');
      expect(result.thingsTask?.tags).toContain('issue');
      expect(result.thingsTask?.tags).toContain('bug');
      expect(result.metadata?.source).toBe('github');
      expect(result.metadata?.url).toBe('https://github.com/test/repo/issues/1');
    });

    it('should handle Notion webhook correctly', async () => {
      const notionEvent: NotionWebhookEvent = {
        id: 'test-notion-1',
        source: 'notion',
        type: 'database',
        timestamp: new Date().toISOString(),
        data: {
          object: 'page',
          id: 'test-page-id',
          created_time: new Date().toISOString(),
          last_edited_time: new Date().toISOString(),
          parent: {
            type: 'database_id',
            database_id: 'test-db-id'
          },
          properties: {
            Name: {
              title: [{
                type: 'text',
                text: { content: 'Test Task' },
                plain_text: 'Test Task'
              }]
            },
            Status: {
              select: { name: 'In Progress' }
            }
          }
        }
      };
      expectTypeOf(notionEvent.data).toMatchTypeOf<NotionEventData>();

      const result = await handlers.handleWebhook(notionEvent);

      expect(result.success).toBe(true);
      expect(result.thingsTask).toBeDefined();
      expect(result.thingsTask?.title).toBe('Notion: Test Task');
      expect(result.thingsTask?.tags).toContain('notion');
      expect(result.metadata?.source).toBe('notion');
    });

    it('should handle Slack webhook correctly', async () => {
      const slackEvent: SlackWebhookEvent = {
        id: 'test-slack-1',
        source: 'slack',
        type: 'star_added',
        timestamp: new Date().toISOString(),
        data: {
          type: 'star_added',
          user: 'U1234567890',
          item: {
            type: 'message',
            channel: 'C1234567890',
            ts: '1234567890.123456',
            message: {
              text: 'This is an important message',
              user: 'U0987654321',
              ts: '1234567890.123456'
            }
          },
          event_ts: '1234567890.123456'
        }
      };
      expectTypeOf(slackEvent.data).toMatchTypeOf<SlackEventData>();

      const result = await handlers.handleWebhook(slackEvent);

      expect(result.success).toBe(true);
      expect(result.thingsTask).toBeDefined();
      expect(result.thingsTask?.title).toBe('Starred Slack message');
      expect(result.thingsTask?.tags).toContain('slack');
      expect(result.thingsTask?.tags).toContain('starred');
      expect(result.metadata?.source).toBe('slack');
    });

      it('should handle generic webhook with transformation rules', async () => {
        const genericEvent: GenericWebhookEvent<{
          type: string;
          title: string;
          description: string;
        }> = {
          id: 'test-generic-1',
          source: 'generic',
          type: 'custom',
          timestamp: new Date().toISOString(),
          data: {
            type: 'test',
            title: 'Sample Task',
            description: 'This is a sample task from external system'
          }
        };

        expectTypeOf(genericEvent.data).toMatchTypeOf<{
          type: string;
          title: string;
          description: string;
        }>();

        const result = await handlers.handleWebhook(genericEvent);

        expect(result.success).toBe(true);
        expect(result.thingsTask).toBeDefined();
        expect(result.thingsTask?.title).toBe('Test: Sample Task');
        expect(result.thingsTask?.notes).toContain('Generated from webhook: This is a sample task from external system');
        expect(result.thingsTask?.tags).toContain('webhook');
        expect(result.thingsTask?.tags).toContain('test');
      });

    it('should filter by repository configuration', async () => {
      const githubEvent: GitHubWebhookEvent = {
        id: 'test-github-2',
        source: 'github',
        type: 'issues',
        timestamp: new Date().toISOString(),
        data: {
          action: 'opened',
          repository: {
            id: 123,
            name: 'unauthorized-repo',
            full_name: 'test/unauthorized-repo',
            html_url: 'https://github.com/test/unauthorized-repo'
          },
          issue: {
            id: 456,
            number: 1,
            title: 'Test Issue',
            body: 'This should be filtered out',
            state: 'open',
            html_url: 'https://github.com/test/unauthorized-repo/issues/1',
            user: {
              login: 'testuser',
              avatar_url: 'https://github.com/testuser.png'
            },
            labels: [],
            assignees: [],
            milestone: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }
        }
      };

      const result = await handlers.handleWebhook(githubEvent);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('Repository not in allowed list');
    });

    it('should handle disabled webhook source', async () => {
      // Disable GitHub webhooks
      const disabledConfig = {
        ...webhookConfig,
        sources: {
          ...webhookConfig.sources,
          github: {
            ...webhookConfig.sources.github,
            enabled: false
          }
        }
      };
      
      const disabledHandlers = new WebhookHandlers(testEnv.env, disabledConfig);
      
      const githubEvent: GitHubWebhookEvent = {
        id: 'test-github-disabled',
        source: 'github',
        type: 'issues',
        timestamp: new Date().toISOString(),
        data: {
          action: 'opened',
          repository: {
            id: 123,
            name: 'test-repo',
            full_name: 'test/repo',
            html_url: 'https://github.com/test/repo'
          }
        }
      };

      const result = await disabledHandlers.handleWebhook(githubEvent);
      
      expect(result.success).toBe(false);
      expect(result.error).toContain('GitHub webhooks are disabled');
    });
  });

  describe('Webhook Configuration', () => {
    it('should validate webhook configuration correctly', async () => {
      // Test valid configuration
      expect(webhookConfig.enabled).toBe(true);
      expect(webhookConfig.sources.github.enabled).toBe(true);
      expect(webhookConfig.rateLimits.perMinute).toBeGreaterThan(0);
      
      // Test source-specific configuration
      expect(webhookConfig.sources.github.repositories).toContain('test/repo');
      expect(webhookConfig.sources.notion.databases).toContain('test-db-id');
      expect(webhookConfig.sources.slack.channels).toContain('C1234567890');
    });
  });
});