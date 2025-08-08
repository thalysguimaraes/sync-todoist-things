import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictResolver } from './conflicts';
import { 
  TaskMapping, 
  SyncConflict, 
  ConflictResolutionStrategy,
  TodoistTask,
  ThingsInboxTask
} from './types';

describe('ConflictResolver', () => {
  let resolver: ConflictResolver;
  let mockKV: any;

  beforeEach(() => {
    resolver = new ConflictResolver({
      conflictStrategy: 'newest_wins',
      autoResolveConflicts: true
    });

    // Mock KV store
    const kvStore = new Map();
    mockKV = {
      get: vi.fn(async (key: string) => kvStore.get(key) || null),
      put: vi.fn(async (key: string, value: string) => kvStore.set(key, value)),
      delete: vi.fn(async (key: string) => kvStore.delete(key))
    };
  });

  describe('detectConflict', () => {
    it('should detect no conflict when lastSyncedContent is missing', async () => {
      const todoistTask: TodoistTask = {
        id: 'todoist-1',
        content: 'Test Task',
        description: 'Notes',
        project_id: 'inbox',
        labels: [],
        priority: 1,
        created_at: '2024-01-01',
        comment_count: 0,
        is_completed: false,
        url: 'https://todoist.com'
      };

      const thingsTask: ThingsInboxTask = {
        id: 'things-1',
        title: 'Test Task',
        notes: 'Notes',
        due: '2024-01-15',
        tags: []
      };

      const mapping: TaskMapping = {
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        fingerprint: {
          primaryHash: 'hash123',
          titleVariations: [],
          fuzzySearchable: 'test task'
        },
        lastSynced: '2024-01-01',
        source: 'exact'
        // No lastSyncedContent
      };

      const conflict = await resolver.detectConflict(todoistTask, thingsTask, mapping);
      expect(conflict).toBeNull();
    });

    it('should detect conflict when both versions changed', async () => {
      const todoistTask: TodoistTask = {
        id: 'todoist-1',
        content: 'Updated Task Title',
        description: 'Updated Notes',
        project_id: 'inbox',
        labels: [],
        priority: 1,
        created_at: '2024-01-01',
        comment_count: 0,
        is_completed: false,
        url: 'https://todoist.com'
      };

      const thingsTask: ThingsInboxTask = {
        id: 'things-1',
        title: 'Different Task Title',
        notes: 'Different Notes',
        due: '2024-01-15',
        tags: []
      };

      const mapping: TaskMapping = {
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        fingerprint: {
          primaryHash: 'hash123',
          titleVariations: [],
          fuzzySearchable: 'test task'
        },
        lastSynced: '2024-01-01',
        source: 'exact',
        lastSyncedContent: {
          title: 'Original Task',
          notes: 'Original Notes',
          due: '2024-01-10'
        }
      };

      const conflict = await resolver.detectConflict(todoistTask, thingsTask, mapping);
      
      expect(conflict).not.toBeNull();
      expect(conflict?.todoistVersion.title).toBe('Updated Task Title');
      expect(conflict?.thingsVersion.title).toBe('Different Task Title');
      expect(conflict?.lastSyncedVersion?.title).toBe('Original Task');
    });

    it('should not detect conflict when only one version changed', async () => {
      const todoistTask: TodoistTask = {
        id: 'todoist-1',
        content: 'Updated Task',
        description: 'Original Notes',
        project_id: 'inbox',
        labels: [],
        priority: 1,
        created_at: '2024-01-01',
        comment_count: 0,
        is_completed: false,
        url: 'https://todoist.com'
      };

      const thingsTask: ThingsInboxTask = {
        id: 'things-1',
        title: 'Original Task',
        notes: 'Original Notes',
        due: undefined,
        tags: []
      };

      const mapping: TaskMapping = {
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        fingerprint: {
          primaryHash: 'hash123',
          titleVariations: [],
          fuzzySearchable: 'original task'
        },
        lastSynced: '2024-01-01',
        source: 'exact',
        lastSyncedContent: {
          title: 'Original Task',
          notes: 'Original Notes'
        }
      };

      const conflict = await resolver.detectConflict(todoistTask, thingsTask, mapping);
      expect(conflict).toBeNull();
    });
  });

  describe('resolveConflict', () => {
    const baseConflict: SyncConflict = {
      id: 'conflict-1',
      todoistId: 'todoist-1',
      thingsId: 'things-1',
      detectedAt: '2024-01-01',
      todoistVersion: {
        title: 'Todoist Title',
        notes: 'Todoist Notes',
        due: '2024-01-15',
        labels: ['work']
      },
      thingsVersion: {
        title: 'Things Title',
        notes: 'Things Notes',
        due: '2024-01-20',
        tags: ['personal']
      },
      lastSyncedVersion: {
        title: 'Original Title',
        notes: 'Original Notes',
        due: '2024-01-10'
      },
      resolved: false
    };

    it('should resolve with todoist_wins strategy', async () => {
      const resolution = await resolver.resolveConflict(baseConflict, 'todoist_wins');
      
      expect(resolution.appliedStrategy).toBe('todoist_wins');
      expect(resolution.resolvedTask.title).toBe('Todoist Title');
      expect(resolution.resolvedTask.notes).toBe('Todoist Notes');
      expect(resolution.resolvedTask.due).toBe('2024-01-15');
    });

    it('should resolve with things_wins strategy', async () => {
      const resolution = await resolver.resolveConflict(baseConflict, 'things_wins');
      
      expect(resolution.appliedStrategy).toBe('things_wins');
      expect(resolution.resolvedTask.title).toBe('Things Title');
      expect(resolution.resolvedTask.notes).toBe('Things Notes');
      expect(resolution.resolvedTask.due).toBe('2024-01-20');
    });

    it('should resolve with newest_wins strategy', async () => {
      const conflictWithTimestamps: SyncConflict = {
        ...baseConflict,
        todoistVersion: {
          ...baseConflict.todoistVersion,
          modifiedAt: '2024-01-02T10:00:00'
        },
        thingsVersion: {
          ...baseConflict.thingsVersion,
          modifiedAt: '2024-01-02T12:00:00'
        }
      };

      const resolution = await resolver.resolveConflict(conflictWithTimestamps, 'newest_wins');
      
      expect(resolution.appliedStrategy).toBe('things_wins');
      expect(resolution.resolvedTask.title).toBe('Things Title');
    });

    it('should merge non-conflicting changes', async () => {
      const mergeableConflict: SyncConflict = {
        ...baseConflict,
        todoistVersion: {
          title: 'Updated Title',
          notes: 'Original Notes', // Not changed
          due: '2024-01-10', // Not changed
          labels: ['work']
        },
        thingsVersion: {
          title: 'Original Title', // Not changed
          notes: 'Updated Notes',
          due: '2024-01-20', // Changed
          tags: ['personal']
        }
      };

      const resolution = await resolver.resolveConflict(mergeableConflict, 'merge');
      
      expect(resolution.appliedStrategy).toBe('merge');
      expect(resolution.resolvedTask.title).toBe('Updated Title'); // From Todoist
      expect(resolution.resolvedTask.notes).toBe('Updated Notes'); // From Things
      expect(resolution.resolvedTask.due).toBe('2024-01-20'); // From Things
    });

    it('should throw error for manual strategy', async () => {
      await expect(
        resolver.resolveConflict(baseConflict, 'manual')
      ).rejects.toThrow('Manual conflict resolution required');
    });
  });

  describe('conflict storage', () => {
    it('should store conflict in KV', async () => {
      const conflict: SyncConflict = {
        id: 'conflict-1',
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        detectedAt: '2024-01-01',
        todoistVersion: {
          title: 'Todoist Title',
          notes: 'Todoist Notes'
        },
        thingsVersion: {
          title: 'Things Title',
          notes: 'Things Notes'
        },
        resolved: false
      };

      await resolver.storeConflict(conflict, mockKV);
      
      expect(mockKV.put).toHaveBeenCalledWith(
        'conflict:conflict-1',
        JSON.stringify(conflict),
        expect.objectContaining({ expirationTtl: 86400 * 7 })
      );
    });

    it('should retrieve unresolved conflicts', async () => {
      const conflict1: SyncConflict = {
        id: 'conflict-1',
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        detectedAt: '2024-01-01',
        todoistVersion: { title: 'Title 1' },
        thingsVersion: { title: 'Title 2' },
        resolved: false
      };

      const conflict2: SyncConflict = {
        id: 'conflict-2',
        todoistId: 'todoist-2',
        thingsId: 'things-2',
        detectedAt: '2024-01-02',
        todoistVersion: { title: 'Title 3' },
        thingsVersion: { title: 'Title 4' },
        resolved: true
      };

      // Mock the KV responses
      mockKV.get = vi.fn(async (key: string) => {
        if (key === 'conflicts:unresolved') {
          return JSON.stringify(['conflict-1', 'conflict-2']);
        }
        if (key === 'conflict:conflict-1') {
          return JSON.stringify(conflict1);
        }
        if (key === 'conflict:conflict-2') {
          return JSON.stringify(conflict2);
        }
        return null;
      });

      const conflicts = await resolver.getUnresolvedConflicts(mockKV);
      
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].id).toBe('conflict-1');
      expect(conflicts[0].resolved).toBe(false);
    });

    it('should mark conflict as resolved', async () => {
      const conflictId = 'conflict-1';
      const conflict: SyncConflict = {
        id: conflictId,
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        detectedAt: '2024-01-01',
        todoistVersion: { title: 'Title 1' },
        thingsVersion: { title: 'Title 2' },
        resolved: false
      };

      mockKV.get = vi.fn(async (key: string) => {
        if (key === `conflict:${conflictId}`) {
          return JSON.stringify(conflict);
        }
        if (key === 'conflicts:unresolved') {
          return JSON.stringify([conflictId, 'conflict-2']);
        }
        return null;
      });

      await resolver.markConflictResolved(conflictId, mockKV);
      
      // Check that conflict was updated with resolved: true
      expect(mockKV.put).toHaveBeenCalledWith(
        `conflict:${conflictId}`,
        expect.stringContaining('"resolved":true')
      );
      
      // Check that conflict was removed from unresolved list
      expect(mockKV.put).toHaveBeenCalledWith(
        'conflicts:unresolved',
        JSON.stringify(['conflict-2'])
      );
    });
  });

  describe('merge strategy', () => {
    it('should combine notes when both changed', async () => {
      const conflict: SyncConflict = {
        id: 'conflict-1',
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        detectedAt: '2024-01-01',
        todoistVersion: {
          title: 'Same Title',
          notes: 'Todoist Notes'
        },
        thingsVersion: {
          title: 'Same Title',
          notes: 'Things Notes'
        },
        lastSyncedVersion: {
          title: 'Same Title',
          notes: 'Original Notes'
        },
        resolved: false
      };

      const resolution = await resolver.resolveConflict(conflict, 'merge');
      
      expect(resolution.resolvedTask.notes).toContain('Todoist Notes');
      expect(resolution.resolvedTask.notes).toContain('---');
      expect(resolution.resolvedTask.notes).toContain('Things Notes');
    });

    it('should take earliest due date when both changed', async () => {
      const conflict: SyncConflict = {
        id: 'conflict-1',
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        detectedAt: '2024-01-01',
        todoistVersion: {
          title: 'Task',
          due: '2024-01-20'
        },
        thingsVersion: {
          title: 'Task',
          due: '2024-01-15'
        },
        lastSyncedVersion: {
          title: 'Task',
          due: '2024-01-10'
        },
        resolved: false
      };

      const resolution = await resolver.resolveConflict(conflict, 'merge');
      
      expect(resolution.resolvedTask.due).toBe('2024-01-15'); // Earlier date
    });

    it('should union tags from both versions', async () => {
      const conflict: SyncConflict = {
        id: 'conflict-1',
        todoistId: 'todoist-1',
        thingsId: 'things-1',
        detectedAt: '2024-01-01',
        todoistVersion: {
          title: 'Task',
          labels: ['work', 'urgent']
        },
        thingsVersion: {
          title: 'Task',
          tags: ['personal', 'urgent']
        },
        resolved: false
      };

      const resolution = await resolver.resolveConflict(conflict, 'merge');
      
      expect(resolution.resolvedTask.labels).toContain('work');
      expect(resolution.resolvedTask.labels).toContain('personal');
      expect(resolution.resolvedTask.labels).toContain('urgent');
      expect(resolution.resolvedTask.labels).toHaveLength(3); // No duplicates
    });
  });
});