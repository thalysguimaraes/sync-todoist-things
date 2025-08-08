import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  createTestEnvironment,
  createMockTodoistTask,
  createMockThingsTask,
  TestDataGenerator,
  waitFor
} from './test-helpers';
import { TodoistClient } from './todoist';
import { ConflictResolver } from './conflicts';
import { ConfigManager } from './config';
import { MetricsTracker } from './metrics';
import worker from './index';

describe('Integration Tests', () => {
  let testEnv: ReturnType<typeof createTestEnvironment>;

  beforeEach(() => {
    testEnv = createTestEnvironment();
  });

  afterEach(() => {
    testEnv.cleanup();
  });

  describe('Bidirectional Sync Flow', () => {
    it('should sync task from Things to Todoist and back', async () => {
      // Create a Things task
      const thingsTask = createMockThingsTask({
        id: 'things-123',
        title: 'Buy groceries',
        notes: 'Milk, bread, eggs',
        tags: ['shopping']
      });

      // Simulate Things → Todoist sync
      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'test-request-1'
        },
        body: JSON.stringify([thingsTask])
      });

      const response = await worker.fetch(request, testEnv.env);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.summary.created).toBe(1);
      expect(result.summary.errors).toBe(0);

      // Verify task mapping was created
      const mappings = await testEnv.kv.list({ prefix: 'hash:' });
      expect(mappings.keys.length).toBeGreaterThan(0);

      // Simulate modification in Todoist
      const todoistId = result.results[0].todoist_id;
      const modifiedTask = createMockTodoistTask({
        id: todoistId,
        content: 'Buy groceries (updated)',
        description: 'Milk, bread, eggs, butter'
      });

      // Store modified task (simulating Todoist update)
      testEnv.todoistAPI.addTask(modifiedTask);

      // Simulate Todoist → Things sync
      const inboxRequest = new Request('https://worker.test/inbox?format=flat', {
        method: 'GET'
      });

      const inboxResponse = await worker.fetch(inboxRequest, testEnv.env);
      const inboxTasks = await inboxResponse.json();

      expect(inboxResponse.status).toBe(200);
      expect(inboxTasks).toHaveLength(1);
      expect(inboxTasks[0].title).toBe('Buy groceries (updated)');
    });

    it('should handle duplicate prevention', async () => {
      const thingsTask = createMockThingsTask({
        id: 'things-456',
        title: 'Test Task',
        notes: 'Test notes'
      });

      // First sync
      const request1 = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([thingsTask])
      });

      const response1 = await worker.fetch(request1, testEnv.env);
      const result1 = await response1.json();
      expect(result1.summary.created).toBe(1);

      // Second sync with same task
      const request2 = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([thingsTask])
      });

      const response2 = await worker.fetch(request2, testEnv.env);
      const result2 = await response2.json();
      expect(result2.summary.existing).toBe(1);
      expect(result2.summary.created).toBe(0);
    });
  });

  describe('Conflict Detection and Resolution', () => {
    it('should detect and auto-resolve conflicts', async () => {
      // Setup initial sync
      const { todoistTask, thingsTask, mapping } = TestDataGenerator.generateConflict();
      
      // Store initial mapping
      await testEnv.kv.put(
        `hash:${mapping.fingerprint.primaryHash}`,
        JSON.stringify(mapping)
      );

      // Configure auto-resolve
      const configManager = new ConfigManager(testEnv.env.SYNC_METADATA);
      await configManager.saveConfig({
        conflictStrategy: 'newest_wins',
        autoResolveConflicts: true
      });

      // Simulate sync with conflicting changes
      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([thingsTask])
      });

      // Mock Todoist API to return modified task
      vi.spyOn(TodoistClient.prototype, 'request').mockResolvedValueOnce(todoistTask);

      const response = await worker.fetch(request, testEnv.env);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.summary.conflictsDetected).toBeGreaterThan(0);
      expect(result.summary.conflictsResolved).toBe(result.summary.conflictsDetected);
    });

    it('should store unresolved conflicts when manual resolution required', async () => {
      const { todoistTask, thingsTask, mapping } = TestDataGenerator.generateConflict();
      
      await testEnv.kv.put(
        `hash:${mapping.fingerprint.primaryHash}`,
        JSON.stringify(mapping)
      );

      // Configure manual resolution
      const configManager = new ConfigManager(testEnv.env.SYNC_METADATA);
      await configManager.saveConfig({
        conflictStrategy: 'manual',
        autoResolveConflicts: false
      });

      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([thingsTask])
      });

      vi.spyOn(TodoistClient.prototype, 'request').mockResolvedValueOnce(todoistTask);

      const response = await worker.fetch(request, testEnv.env);
      const result = await response.json();

      expect(result.summary.conflictsDetected).toBeGreaterThan(0);
      expect(result.summary.conflictsResolved).toBe(0);

      // Check that conflict was stored
      const conflictsRequest = new Request('https://worker.test/conflicts', {
        method: 'GET'
      });

      const conflictsResponse = await worker.fetch(conflictsRequest, testEnv.env);
      const conflicts = await conflictsResponse.json();

      expect(conflicts.count).toBeGreaterThan(0);
    });
  });

  describe('Bulk Operations', () => {
    it('should handle bulk sync of multiple tasks', async () => {
      const { thingsTasks } = TestDataGenerator.generateTaskSet(50);

      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(thingsTasks)
      });

      const response = await worker.fetch(request, testEnv.env);
      const result = await response.json();

      expect(response.status).toBe(200);
      expect(result.summary.total).toBe(50);
      expect(result.summary.errors).toBe(0);

      // Verify all mappings were created
      const mappings = await testEnv.kv.list({ prefix: 'hash:' });
      expect(mappings.keys.length).toBeGreaterThanOrEqual(50);
    });

    it('should handle bulk sync with auth protection', async () => {
      const request = new Request('https://worker.test/sync/bulk?dry_run=true', {
        method: 'POST',
        headers: {
          'X-Repair-Auth': 'wrong-token'
        }
      });

      const response = await worker.fetch(request, testEnv.env);
      expect(response.status).toBe(401);
    });
  });

  describe('Idempotency', () => {
    it('should return cached response for duplicate requests', async () => {
      const thingsTask = createMockThingsTask({
        id: 'things-789',
        title: 'Idempotent Task'
      });

      const requestId = 'idempotent-request-1';
      
      // First request
      const request1 = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        },
        body: JSON.stringify([thingsTask])
      });

      const response1 = await worker.fetch(request1, testEnv.env);
      const result1 = await response1.json();
      expect(result1.fromCache).toBeUndefined();

      // Duplicate request with same ID
      const request2 = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': requestId
        },
        body: JSON.stringify([thingsTask])
      });

      const response2 = await worker.fetch(request2, testEnv.env);
      const result2 = await response2.json();
      expect(result2.fromCache).toBe(true);
      expect(result2.summary).toEqual(result1.summary);
    });
  });

  describe('Configuration and Filtering', () => {
    it('should apply project filtering', async () => {
      // Configure to only sync "Work" project
      const configManager = new ConfigManager(testEnv.env.SYNC_METADATA);
      await configManager.saveConfig({
        enabledProjects: ['Work'],
        conflictStrategy: 'newest_wins',
        autoResolveConflicts: true
      });

      const workTask = createMockThingsTask({
        id: 'things-work',
        title: 'Work Task',
        project: 'Work'
      });

      const personalTask = createMockThingsTask({
        id: 'things-personal',
        title: 'Personal Task',
        project: 'Personal'
      });

      // Verify configuration filtering
      const config = configManager.getConfig();
      expect(configManager.shouldSyncProject('Work')).toBe(true);
      expect(configManager.shouldSyncProject('Personal')).toBe(false);
    });

    it('should apply tag filtering', async () => {
      const configManager = new ConfigManager(testEnv.env.SYNC_METADATA);
      await configManager.saveConfig({
        enabledTags: ['important', 'urgent'],
        excludedTags: ['draft', 'synced-from-todoist'],
        conflictStrategy: 'newest_wins',
        autoResolveConflicts: true
      });

      expect(configManager.shouldSyncTag('important')).toBe(true);
      expect(configManager.shouldSyncTag('draft')).toBe(false);
      expect(configManager.shouldSyncTag('synced-from-todoist')).toBe(false);
      expect(configManager.shouldSyncTag('random')).toBe(false); // Not in enabled list
    });
  });

  describe('Error Recovery', () => {
    it('should handle network failures gracefully', async () => {
      // Simulate network failure
      vi.spyOn(TodoistClient.prototype, 'request').mockRejectedValueOnce(
        new Error('Network error')
      );

      const thingsTask = createMockThingsTask({
        id: 'things-error',
        title: 'Error Task'
      });

      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([thingsTask])
      });

      const response = await worker.fetch(request, testEnv.env);
      const result = await response.json();

      expect(response.status).toBe(200); // Should still return 200
      expect(result.summary.errors).toBeGreaterThan(0);
      expect(result.results[0].status).toBe('error');
    });

    it('should respect sync lock to prevent concurrent syncs', async () => {
      // Acquire sync lock
      await testEnv.kv.put('sync:lock', JSON.stringify({
        timestamp: Date.now(),
        processId: 'other-process'
      }));

      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([])
      });

      const response = await worker.fetch(request, testEnv.env);
      expect(response.status).toBe(429); // Too Many Requests
      
      const result = await response.json();
      expect(result.error).toContain('Sync already in progress');
    });
  });

  describe('Metrics Tracking', () => {
    it('should track sync metrics', async () => {
      const metricsTracker = new MetricsTracker(testEnv.env);
      const thingsTask = createMockThingsTask();

      const request = new Request('https://worker.test/things/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([thingsTask])
      });

      await worker.fetch(request, testEnv.env);

      // Get metrics summary
      const metricsRequest = new Request('https://worker.test/metrics?hours=1', {
        method: 'GET'
      });

      const metricsResponse = await worker.fetch(metricsRequest, testEnv.env);
      const metrics = await metricsResponse.json();

      expect(metrics.totalSyncs).toBeGreaterThan(0);
      expect(metrics.byType['things_sync']).toBeDefined();
    });
  });
});