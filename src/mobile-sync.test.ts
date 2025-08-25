import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MobileAuthManager } from './mobile-auth';
import { MobileSyncManager } from './mobile-sync';
import { createTestEnvironment } from './test-helpers';
import { MobileSyncRequest, MobileTask } from './mobile-types';

describe('Mobile Sync', () => {
  let testEnv: ReturnType<typeof createTestEnvironment>;
  let mobileAuth: MobileAuthManager;
  let mobileSync: MobileSyncManager;

  beforeEach(() => {
    testEnv = createTestEnvironment();
    mobileAuth = new MobileAuthManager(testEnv.env);
    mobileSync = new MobileSyncManager(testEnv.env);
  });

  describe('Device Registration', () => {
    it('should register a new device', async () => {
      const registration = await mobileAuth.registerDevice('android', '1.0.0');

      expect(registration.deviceId).toBeDefined();
      expect(registration.secret).toBeDefined();
      expect(registration.registeredAt).toBeDefined();
      expect(registration.platform).toBe('android');
      expect(registration.appVersion).toBe('1.0.0');
    });

    it('should retrieve a registered device', async () => {
      const registration = await mobileAuth.registerDevice('ios', '1.0.1');
      const retrieved = await mobileAuth.getDevice(registration.deviceId);

      expect(retrieved).toEqual(registration);
    });
  });

  describe('HMAC Authentication', () => {
    it('should create and verify valid signatures', async () => {
      const secret = 'test-secret';
      const payload = { test: 'data' };
      const timestamp = new Date().toISOString();

      const message = JSON.stringify(payload) + timestamp;
      const signature = await mobileAuth.createSignature(secret, message);
      
      // Mock device with known secret
      const deviceId = 'test-device';
      await testEnv.env.SYNC_METADATA.put(`device:${deviceId}`, JSON.stringify({
        deviceId,
        secret,
        registeredAt: new Date().toISOString()
      }));

      const isValid = await mobileAuth.verifySignature(
        deviceId,
        payload,
        signature,
        timestamp
      );

      expect(isValid).toBe(true);
    });

    it('should reject signatures with old timestamps', async () => {
      const secret = 'test-secret';
      const message = 'test-message';
      const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes ago

      const signature = await mobileAuth.createSignature(secret, message + oldTimestamp);
      
      // Mock device with known secret
      const deviceId = 'test-device';
      await testEnv.env.SYNC_METADATA.put(`device:${deviceId}`, JSON.stringify({
        deviceId,
        secret,
        registeredAt: new Date().toISOString()
      }));

      const isValid = await mobileAuth.verifySignature(
        deviceId,
        message,
        signature,
        oldTimestamp
      );

      expect(isValid).toBe(false);
    });
  });

  describe('Mobile Task Sync', () => {
    it('should process sync request with created tasks', async () => {
      // Setup device
      const registration = await mobileAuth.registerDevice('android', '1.0.0');

      const mobileTask: MobileTask = {
        id: 'mobile-task-1',
        title: 'Test Task',
        notes: 'Test notes',
        due: null,
        status: 'open',
        list: 'inbox',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        syncState: 'dirty'
      };

      const timestamp = new Date().toISOString();
      const payload = {
        changes: { created: [mobileTask], updated: [], completed: [], deleted: [] },
        lastSyncAt: null
      };
      const signature = await mobileAuth.createSignature(
        registration.secret,
        JSON.stringify(payload) + timestamp
      );

      const syncRequest: MobileSyncRequest = {
        deviceId: registration.deviceId,
        changes: payload.changes,
        lastSyncAt: null,
        signature,
        timestamp
      };

      // Mock Todoist client methods
      const mockTodoistResponse = {
        id: 'todoist-123',
        content: mobileTask.title,
        description: mobileTask.notes,
        project_id: 'inbox-project'
      };

      // Mock the createTask method
      vi.spyOn(mobileSync['todoist'], 'createTask').mockResolvedValue(mockTodoistResponse as any);

      const response = await mobileSync.processSyncRequest(syncRequest);

      expect(response.success).toBe(true);
      expect(response.mappings).toHaveLength(1);
      expect(response.mappings[0].mobileId).toBe(mobileTask.id);
    });

    it('should reject sync request with invalid signature', async () => {
      const mobileTask: MobileTask = {
        id: 'mobile-task-1',
        title: 'Test Task',
        notes: 'Test notes',
        due: null,
        status: 'open',
        list: 'inbox',
        labels: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        syncState: 'dirty'
      };

      const syncRequest: MobileSyncRequest = {
        deviceId: 'non-existent-device',
        changes: { created: [mobileTask], updated: [], completed: [], deleted: [] },
        lastSyncAt: null,
        signature: 'invalid-signature',
        timestamp: new Date().toISOString()
      };

      await expect(mobileSync.processSyncRequest(syncRequest)).rejects.toThrow('Invalid signature');
    });
  });
});
