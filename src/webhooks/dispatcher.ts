// Webhook dispatcher - coordinates webhook processing
import {
  WebhookSource,
  WebhookTransformation,
  WebhookConfig,
  OutboundWebhookEvent,
  OutboundWebhookPayload,
  AnyWebhookEvent
} from './types';
import { WebhookHandlers } from './handlers';
import { WebhookSecurity } from './security';
import { Env } from '../types';
import { MetricsTracker } from '../metrics';
import { ConfigManager } from '../config';

export class WebhookDispatcher {
  private handlers: WebhookHandlers;
  private security: WebhookSecurity;
  private metrics: MetricsTracker;

  constructor(private env: Env) {
    this.security = new WebhookSecurity(env);
    this.metrics = new MetricsTracker(env);
  }

  /**
   * Process incoming webhook request
   */
  async processWebhook(
    source: WebhookSource,
    request: Request
  ): Promise<Response> {
    const startTime = Date.now();
    let webhookEvent: AnyWebhookEvent | null = null;

    try {
      // Get webhook configuration
      const configManager = new ConfigManager(this.env.SYNC_METADATA);
      await configManager.loadConfig();
      const config = configManager.getConfig();
      const webhookConfig = await this.getWebhookConfig();

      if (!webhookConfig) {
        return this.errorResponse('Webhook configuration not found', 500);
      }

      // Check if source is enabled
      if (!webhookConfig.sources[source]?.enabled) {
        return this.errorResponse(`${source} webhooks are disabled`, 403);
      }

      // Rate limiting
      const rateLimit = await this.security.checkRateLimit(
        source,
        webhookConfig.rateLimits.perMinute,
        webhookConfig.rateLimits.perHour
      );

      if (!rateLimit.allowed) {
        const headers: Record<string, string> = {};
        if (rateLimit.resetMinute) {
          headers['X-RateLimit-Reset-Minute'] = rateLimit.resetMinute.toString();
        }
        if (rateLimit.resetHour) {
          headers['X-RateLimit-Reset-Hour'] = rateLimit.resetHour.toString();
        }

        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            ...headers
          }
        });
      }

      // Get payload
      const payloadText = await request.text();
      let payload;

      try {
        payload = JSON.parse(payloadText);
      } catch {
        return this.errorResponse('Invalid JSON payload', 400);
      }

      // Validate payload structure
      if (!this.security.validatePayload(source, payload)) {
        return this.errorResponse('Invalid payload structure', 400);
      }

      // Verify signature
      const signature = this.getSignatureFromHeaders(source, request);
      const secret = webhookConfig.sources[source].secret;
      const timestamp =
        source === 'slack' ? request.headers.get('X-Slack-Request-Timestamp') : null;

      const isValidSignature = await this.security.verifySignature(
        source,
        payloadText,
        signature,
        secret,
        timestamp
      );

      if (!isValidSignature) {
        return this.errorResponse('Invalid signature', 401);
      }

      // Create webhook event
      webhookEvent = {
        id: `webhook-${source}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        source,
        type: this.extractEventType(source, payload, request),
        timestamp: new Date().toISOString(),
        // The payload structure varies by source; it is sanitised but
        // otherwise unchecked here and will be validated by specific
        // handlers.
        data: this.security.sanitizePayload(payload),
        signature,
        deliveryId: request.headers.get('X-Delivery-ID') || undefined
      } as AnyWebhookEvent;

      // Initialize handlers with config
      this.handlers = new WebhookHandlers(this.env, webhookConfig);

      // Process webhook event
      const transformation = await this.handlers.handleWebhook(webhookEvent);

      if (transformation.success && transformation.thingsTask) {
        // Create task in Things via sync system
        const syncSuccess = await this.createThingsTask(transformation);
        
        if (syncSuccess) {
          // Send outbound webhook notification
          await this.sendOutboundWebhook('task_synced', {
            source: source,
            target: 'things',
            task: transformation.thingsTask,
            metadata: transformation.metadata
          });
        }

        // Record success metric
        await this.metrics.recordMetric({
          timestamp: new Date().toISOString(),
          type: 'webhook_processed',
          success: syncSuccess,
          duration: Date.now() - startTime,
          details: {
            source,
            eventType: webhookEvent.type,
            taskCreated: syncSuccess,
            deliveryId: webhookEvent.deliveryId
          }
        });

        return new Response(JSON.stringify({
          received: true,
          processed: syncSuccess,
          eventId: webhookEvent.id,
          taskTitle: transformation.thingsTask.title
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // Record processing error
        await this.metrics.recordMetric({
          timestamp: new Date().toISOString(),
          type: 'webhook_processed',
          success: false,
          duration: Date.now() - startTime,
          details: {
            source,
            eventType: webhookEvent?.type,
            deliveryId: webhookEvent?.deliveryId
          },
          errorMessage: transformation.error || 'Unknown processing error'
        });

        return new Response(JSON.stringify({
          received: true,
          processed: false,
          error: transformation.error || 'Processing failed'
        }), {
          status: 200, // Still return 200 to acknowledge receipt
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      console.error('Webhook processing error:', error);

      // Record error metric
      await this.metrics.recordMetric({
        timestamp: new Date().toISOString(),
        type: 'webhook_processed',
        success: false,
        duration: Date.now() - startTime,
        details: {
          source,
          eventType: webhookEvent?.type,
          deliveryId: webhookEvent?.deliveryId
        },
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });

      return this.errorResponse('Internal server error', 500);
    }
  }

  /**
   * Create task in Things via sync coordination
   */
  private async createThingsTask(transformation: WebhookTransformation): Promise<boolean> {
    try {
      if (!transformation.thingsTask) {
        return false;
      }

      // Create a sync request for the local script to process
      const syncRequest = {
        id: `webhook-sync-${Date.now()}`,
        timestamp: new Date().toISOString(),
        type: 'webhook_to_things',
        task: transformation.thingsTask,
        metadata: transformation.metadata,
        status: 'pending'
      };

      if (this.env.ENABLE_WEBHOOK_LOGS === 'true') {
        await this.env.SYNC_METADATA.put(
          `sync-request:${syncRequest.id}`,
          JSON.stringify(syncRequest),
          { expirationTtl: 300 }
        );
      }

      return true;
    } catch (error) {
      console.error('Failed to create Things task:', error);
      return false;
    }
  }

  /**
   * Send outbound webhook notification
   */
  private async sendOutboundWebhook(
    event: OutboundWebhookEvent, 
    data: any
  ): Promise<void> {
    try {
      // Get outbound webhook subscribers
      const subscribers = await this.getOutboundWebhookSubscribers();
      
      for (const subscriber of subscribers) {
        if (subscriber.enabled && subscriber.events.includes(event)) {
          const payload: OutboundWebhookPayload = {
            event,
            timestamp: new Date().toISOString(),
            data
          };

          // Add signature if secret is configured
          if (subscriber.secret) {
            const hmac = await crypto.subtle.importKey(
              'raw',
              new TextEncoder().encode(subscriber.secret),
              { name: 'HMAC', hash: 'SHA-256' },
              false,
              ['sign']
            );
            const signature = await crypto.subtle.sign(
              'HMAC', 
              hmac, 
              new TextEncoder().encode(JSON.stringify(payload))
            );
            payload.signature = Array.from(new Uint8Array(signature))
              .map(b => b.toString(16).padStart(2, '0'))
              .join('');
          }

          // Send webhook (fire and forget for now)
          this.deliverOutboundWebhook(subscriber.url, payload)
            .catch(error => console.error('Outbound webhook delivery failed:', error));
        }
      }
    } catch (error) {
      console.error('Outbound webhook error:', error);
    }
  }

  /**
   * Deliver outbound webhook
   */
  private async deliverOutboundWebhook(url: string, payload: OutboundWebhookPayload): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Todoist-Things-Sync/1.0'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Get webhook configuration from KV storage
   */
  private async getWebhookConfig(): Promise<WebhookConfig | null> {
    try {
      const config = await this.env.SYNC_METADATA.get('webhook-config');
      return config ? JSON.parse(config) : null;
    } catch {
      return null;
    }
  }

  /**
   * Get outbound webhook subscribers
   */
  private async getOutboundWebhookSubscribers(): Promise<any[]> {
    try {
      const subscribers = await this.env.SYNC_METADATA.get('outbound-webhooks');
      return subscribers ? JSON.parse(subscribers) : [];
    } catch {
      return [];
    }
  }

  /**
   * Extract signature from request headers based on source
   */
  private getSignatureFromHeaders(source: WebhookSource, request: Request): string | null {
    switch (source) {
      case 'github':
        return request.headers.get('X-Hub-Signature-256');
      case 'slack':
        return request.headers.get('X-Slack-Signature');
      case 'notion':
        return request.headers.get('Notion-Signature');
      case 'generic':
        return request.headers.get('X-Signature') || 
               request.headers.get('X-Hub-Signature-256') ||
               request.headers.get('X-Webhook-Signature');
      default:
        return null;
    }
  }

  /**
   * Extract event type from payload based on source
   */
  private extractEventType(source: WebhookSource, payload: any, request?: Request): string {
    switch (source) {
      case 'github':
        return request?.headers.get('X-GitHub-Event') || payload.action || 'unknown';
      case 'slack':
        return payload.type || 'unknown';
      case 'notion':
        return payload.object || 'unknown';
      case 'generic':
        return payload.event_type || payload.type || 'generic';
      default:
        return 'unknown';
    }
  }

  /**
   * Create error response
   */
  private errorResponse(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}