import { Env } from './types';
import { DeviceRegistration } from './mobile-types';

export class MobileAuthManager {
  constructor(private env: Env) {}

  async registerDevice(platform?: string, appVersion?: string): Promise<DeviceRegistration> {
    const deviceId = crypto.randomUUID();
    const secret = this.generateSecret();
    
    const registration: DeviceRegistration = {
      deviceId,
      secret,
      registeredAt: new Date().toISOString(),
      platform,
      appVersion
    };

    await this.env.SYNC_METADATA.put(
      `device:${deviceId}`,
      JSON.stringify(registration)
    );

    return registration;
  }

  async getDevice(deviceId: string): Promise<DeviceRegistration | null> {
    const stored = await this.env.SYNC_METADATA.get(`device:${deviceId}`);
    if (!stored) return null;
    
    return JSON.parse(stored);
  }

  async updateLastSeen(deviceId: string): Promise<void> {
    const device = await this.getDevice(deviceId);
    if (!device) return;

    device.lastSeen = new Date().toISOString();
    await this.env.SYNC_METADATA.put(
      `device:${deviceId}`,
      JSON.stringify(device)
    );
  }

  async verifySignature(
    deviceId: string, 
    payload: any, 
    signature: string, 
    timestamp: string
  ): Promise<boolean> {
    const device = await this.getDevice(deviceId);
    if (!device) return false;

    // Check timestamp to prevent replay attacks (within 5 minutes)
    const requestTime = new Date(timestamp).getTime();
    const now = Date.now();
    if (now - requestTime > 5 * 60 * 1000) return false;

    // Create expected signature
    const message = JSON.stringify(payload) + timestamp;
    const expectedSignature = await this.createSignature(device.secret, message);
    
    return signature === expectedSignature;
  }

  async createSignature(secret: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private generateSecret(): string {
    // Generate a 32-byte random secret
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }
}
