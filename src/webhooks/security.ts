// Webhook security and signature verification
import { WebhookSource, WebhookRateLimit } from './types';
import { Env } from '../types';

export class WebhookSecurity {
  constructor(private env: Env) {}

  /**
   * Verify webhook signature based on the source
   */
  async verifySignature(
    source: WebhookSource,
    payload: string,
    signature: string | null,
    secret: string,
    timestamp?: string | null
  ): Promise<boolean> {
    if (!signature || !secret) {
      return false;
    }

    try {
      switch (source) {
        case 'github':
          return await this.verifyGitHubSignature(payload, signature, secret);
        case 'slack':
          return await this.verifySlackSignature(payload, signature, secret, timestamp);
        case 'generic':
          return await this.verifyGenericSignature(payload, signature, secret);
        case 'notion':
          // Notion uses different verification method
          return await this.verifyNotionSignature(payload, signature, secret);
        default:
          return false;
      }
    } catch (error) {
      console.error('Signature verification error:', error);
      return false;
    }
  }

  /**
   * Verify GitHub webhook signature (HMAC-SHA256)
   */
  private async verifyGitHubSignature(
    payload: string,
    signature: string,
    secret: string
  ): Promise<boolean> {
    // GitHub signature format: "sha256=<signature>"
    if (!signature.startsWith('sha256=')) {
      return false;
    }

    const expectedSignature = signature.slice(7); // Remove "sha256=" prefix
    const computedSignature = await this.computeHMAC(payload, secret, 'SHA-256');
    
    return this.constantTimeCompare(expectedSignature, computedSignature);
  }

  /**
   * Verify Slack webhook signature (HMAC-SHA256)
   */
  private async verifySlackSignature(
    payload: string,
    signature: string,
    secret: string,
    timestamp: string | null | undefined
  ): Promise<boolean> {
    // Slack signature format: "v0=<signature>"
    if (!signature.startsWith('v0=')) {
      return false;
    }

    if (!timestamp) {
      return false;
    }

    const ts = Number(timestamp);
    if (Number.isNaN(ts)) {
      return false;
    }

    const now = Math.floor(Date.now() / 1000);
    // Reject if timestamp is older than 5 minutes to prevent replay attacks
    if (Math.abs(now - ts) > 60 * 5) {
      return false;
    }

    const baseString = `v0:${timestamp}:${payload}`;
    const computedSignature = await this.computeHMAC(baseString, secret, 'SHA-256');
    const expectedSignature = `v0=${computedSignature}`;

    return this.constantTimeCompare(signature, expectedSignature);
  }

  /**
   * Verify Notion webhook signature
   */
  private async verifyNotionSignature(
    payload: string,
    signature: string,
    secret: string
  ): Promise<boolean> {
    // Notion uses HMAC-SHA256 but with different format
    const computedSignature = await this.computeHMAC(payload, secret, 'SHA-256');
    return this.constantTimeCompare(signature, computedSignature);
  }

  /**
   * Verify generic webhook signature (configurable format)
   */
  private async verifyGenericSignature(
    payload: string,
    signature: string,
    secret: string
  ): Promise<boolean> {
    // Support both raw signature and common prefixes
    let expectedSignature = signature;
    
    if (signature.startsWith('sha256=')) {
      expectedSignature = signature.slice(7);
    } else if (signature.startsWith('v0=')) {
      expectedSignature = signature.slice(3);
    }

    const computedSignature = await this.computeHMAC(payload, secret, 'SHA-256');
    return this.constantTimeCompare(expectedSignature, computedSignature);
  }

  /**
   * Compute HMAC signature
   */
  private async computeHMAC(
    message: string,
    secret: string,
    algorithm: 'SHA-1' | 'SHA-256' = 'SHA-256'
  ): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: algorithm },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, messageData);
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Constant-time string comparison to prevent timing attacks
   */
  private constantTimeCompare(expected: string, actual: string): boolean {
    if (expected.length !== actual.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
    }
    
    return result === 0;
  }

  /**
   * Check rate limits for webhook source
   */
  async checkRateLimit(
    source: WebhookSource,
    perMinute: number,
    perHour: number
  ): Promise<{ allowed: boolean; resetMinute?: number; resetHour?: number }> {
    const now = Date.now();
    const currentMinute = Math.floor(now / 60000); // Minutes since epoch
    const currentHour = Math.floor(now / 3600000); // Hours since epoch

    const rateLimitKey = `webhook-rate:${source}`;
    const rateLimitData = await this.env.SYNC_METADATA.get(rateLimitKey);

    let rateLimit: WebhookRateLimit = {
      source,
      minute: 0,
      hour: 0,
      resetMinute: currentMinute,
      resetHour: currentHour
    };

    if (rateLimitData) {
      rateLimit = JSON.parse(rateLimitData);
    }

    // Reset counters if time period has passed
    if (currentMinute > rateLimit.resetMinute) {
      rateLimit.minute = 0;
      rateLimit.resetMinute = currentMinute;
    }

    if (currentHour > rateLimit.resetHour) {
      rateLimit.hour = 0;
      rateLimit.resetHour = currentHour;
    }

    // Check limits
    if (rateLimit.minute >= perMinute || rateLimit.hour >= perHour) {
      return { 
        allowed: false,
        resetMinute: (rateLimit.resetMinute + 1) * 60000,
        resetHour: (rateLimit.resetHour + 1) * 3600000
      };
    }

    // Increment counters
    rateLimit.minute += 1;
    rateLimit.hour += 1;

    // Save updated rate limit
    await this.env.SYNC_METADATA.put(rateLimitKey, JSON.stringify(rateLimit), {
      expirationTtl: 3600 // Expire in 1 hour
    });

    return { allowed: true };
  }

  /**
   * Validate webhook payload structure
   */
  validatePayload(source: WebhookSource, payload: any): boolean {
    try {
      switch (source) {
        case 'github':
          return this.validateGitHubPayload(payload);
        case 'notion':
          return this.validateNotionPayload(payload);
        case 'slack':
          return this.validateSlackPayload(payload);
        case 'generic':
          return typeof payload === 'object' && payload !== null;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /**
   * Validate GitHub webhook payload structure
   */
  private validateGitHubPayload(payload: any): boolean {
    return (
      payload &&
      typeof payload.action === 'string' &&
      payload.repository &&
      typeof payload.repository.full_name === 'string' &&
      typeof payload.repository.html_url === 'string'
    );
  }

  /**
   * Validate Notion webhook payload structure
   */
  private validateNotionPayload(payload: any): boolean {
    return (
      payload &&
      typeof payload.object === 'string' &&
      typeof payload.id === 'string'
    );
  }

  /**
   * Validate Slack webhook payload structure
   */
  private validateSlackPayload(payload: any): boolean {
    return (
      payload &&
      typeof payload.type === 'string' &&
      typeof payload.user === 'string'
    );
  }

  /**
   * Sanitize webhook payload for storage
   */
  sanitizePayload(payload: any): any {
    // Remove potentially sensitive fields
    const sanitized = { ...payload };
    
    // Remove common sensitive fields
    delete sanitized.token;
    delete sanitized.secret;
    delete sanitized.password;
    delete sanitized.api_key;
    delete sanitized.apiKey;
    
    // Limit payload size for storage
    const jsonString = JSON.stringify(sanitized);
    if (jsonString.length > 50000) { // 50KB limit
      return {
        ...sanitized,
        _truncated: true,
        _originalSize: jsonString.length
      };
    }
    
    return sanitized;
  }

  /**
   * Generate secure webhook secret
   */
  static generateWebhookSecret(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Validate webhook URL format
   */
  static validateWebhookURL(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname !== 'localhost';
    } catch {
      return false;
    }
  }
}