import { 
  TodoistTask, 
  ThingsInboxTask, 
  TaskMapping,
  SyncMetadata,
  SyncConflict
} from './types';

/**
 * Generate a mock Todoist task
 */
export function createMockTodoistTask(overrides: Partial<TodoistTask> = {}): TodoistTask {
  return {
    id: `todoist-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    content: 'Test Task',
    description: 'Test Notes',
    project_id: 'inbox',
    labels: [],
    priority: 1,
    created_at: new Date().toISOString(),
    comment_count: 0,
    is_completed: false,
    url: 'https://todoist.com/task',
    creator_id: 'user123',
    ...overrides
  };
}

/**
 * Generate a mock Things task
 */
export function createMockThingsTask(overrides: Partial<ThingsInboxTask> = {}): ThingsInboxTask {
  return {
    id: `things-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    title: 'Test Task',
    notes: 'Test Notes',
    due: undefined,
    tags: [],
    ...overrides
  };
}

/**
 * Generate a mock task mapping
 */
export function createMockTaskMapping(overrides: Partial<TaskMapping> = {}): TaskMapping {
  return {
    todoistId: `todoist-${Date.now()}`,
    thingsId: `things-${Date.now()}`,
    fingerprint: {
      primaryHash: `hash-${Date.now()}`,
      titleVariations: [],
      fuzzySearchable: 'test task'
    },
    lastSynced: new Date().toISOString(),
    source: 'exact',
    version: 2,
    ...overrides
  };
}

/**
 * Mock KV store implementation for testing
 */
export class MockKVStore implements KVNamespace {
  private store: Map<string, { value: string; metadata?: any; expiry?: number }> = new Map();

  async get(key: string, options?: any): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    
    // Check expiry
    if (item.expiry && item.expiry < Date.now()) {
      this.store.delete(key);
      return null;
    }
    
    return item.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number; metadata?: any }): Promise<void> {
    const expiry = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined;
    this.store.set(key, { value, metadata: options?.metadata, expiry });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { name: string }[] }> {
    const keys: { name: string }[] = [];
    const prefix = options?.prefix || '';
    const limit = options?.limit || Infinity;
    
    for (const [key] of this.store) {
      if (key.startsWith(prefix)) {
        keys.push({ name: key });
        if (keys.length >= limit) break;
      }
    }
    
    return { keys };
  }

  // Test helper methods
  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  getWithMetadata(key: string): any {
    throw new Error('Not implemented');
  }
}

/**
 * Mock Todoist API responses
 */
export class MockTodoistAPI {
  private tasks: Map<string, TodoistTask> = new Map();
  private projects = [
    { id: 'inbox', name: 'Inbox', is_inbox_project: true },
    { id: 'work', name: 'Work', is_inbox_project: false },
    { id: 'personal', name: 'Personal', is_inbox_project: false }
  ];

  addTask(task: TodoistTask): void {
    this.tasks.set(task.id, task);
  }

  getTask(id: string): TodoistTask | null {
    return this.tasks.get(id) || null;
  }

  getTasks(projectId?: string): TodoistTask[] {
    const tasks = Array.from(this.tasks.values());
    if (projectId) {
      return tasks.filter(t => t.project_id === projectId);
    }
    return tasks;
  }

  updateTask(id: string, updates: Partial<TodoistTask>): TodoistTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    
    const updated = { ...task, ...updates };
    this.tasks.set(id, updated);
    return updated;
  }

  deleteTask(id: string): boolean {
    return this.tasks.delete(id);
  }

  closeTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    
    task.is_completed = true;
    return true;
  }

  getProjects() {
    return this.projects;
  }

  clear(): void {
    this.tasks.clear();
  }
}

/**
 * Test data generators
 */
export class TestDataGenerator {
  /**
   * Generate a set of tasks with various states
   */
  static generateTaskSet(count: number = 10): {
    todoistTasks: TodoistTask[],
    thingsTasks: ThingsInboxTask[]
  } {
    const todoistTasks: TodoistTask[] = [];
    const thingsTasks: ThingsInboxTask[] = [];
    
    for (let i = 0; i < count; i++) {
      const baseTitle = `Task ${i + 1}`;
      const baseNotes = `Notes for task ${i + 1}`;
      
      // Create matching pairs with slight variations
      if (i % 3 === 0) {
        // Identical tasks
        todoistTasks.push(createMockTodoistTask({
          id: `todoist-${i}`,
          content: baseTitle,
          description: baseNotes
        }));
        
        thingsTasks.push(createMockThingsTask({
          id: `things-${i}`,
          title: baseTitle,
          notes: baseNotes
        }));
      } else if (i % 3 === 1) {
        // Tasks with modifications
        todoistTasks.push(createMockTodoistTask({
          id: `todoist-${i}`,
          content: `${baseTitle} (updated)`,
          description: baseNotes
        }));
        
        thingsTasks.push(createMockThingsTask({
          id: `things-${i}`,
          title: baseTitle,
          notes: `${baseNotes} (modified)`
        }));
      } else {
        // Unique tasks
        todoistTasks.push(createMockTodoistTask({
          id: `todoist-${i}`,
          content: `Todoist only: ${baseTitle}`,
          description: baseNotes
        }));
        
        thingsTasks.push(createMockThingsTask({
          id: `things-${i}`,
          title: `Things only: ${baseTitle}`,
          notes: baseNotes
        }));
      }
    }
    
    return { todoistTasks, thingsTasks };
  }

  /**
   * Generate a conflict scenario
   */
  static generateConflict(): {
    todoistTask: TodoistTask,
    thingsTask: ThingsInboxTask,
    mapping: TaskMapping,
    conflict: SyncConflict
  } {
    const todoistTask = createMockTodoistTask({
      id: 'todoist-conflict',
      content: 'Updated in Todoist',
      description: 'Todoist notes',
      created_at: '2024-01-01T10:00:00Z'
    });
    
    const thingsTask = createMockThingsTask({
      id: 'things-conflict',
      title: 'Updated in Things',
      notes: 'Things notes'
    });
    
    const mapping = createMockTaskMapping({
      todoistId: todoistTask.id,
      thingsId: thingsTask.id,
      lastSyncedContent: {
        title: 'Original Title',
        notes: 'Original notes'
      },
      todoistModifiedAt: '2024-01-01T11:00:00Z',
      thingsModifiedAt: '2024-01-01T11:30:00Z'
    });
    
    const conflict: SyncConflict = {
      id: 'conflict-test',
      todoistId: todoistTask.id,
      thingsId: thingsTask.id,
      detectedAt: new Date().toISOString(),
      todoistVersion: {
        title: todoistTask.content,
        notes: todoistTask.description,
        modifiedAt: mapping.todoistModifiedAt
      },
      thingsVersion: {
        title: thingsTask.title,
        notes: thingsTask.notes,
        modifiedAt: mapping.thingsModifiedAt
      },
      lastSyncedVersion: mapping.lastSyncedContent,
      resolved: false
    };
    
    return { todoistTask, thingsTask, mapping, conflict };
  }
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error('Timeout waiting for condition');
}

/**
 * Create a test environment with mocked dependencies
 */
export function createTestEnvironment() {
  const kv = new MockKVStore();
  const todoistAPI = new MockTodoistAPI();
  
  const env = {
    TODOIST_API_TOKEN: 'test-token',
    TODOIST_API_URL: 'https://api.todoist.com/rest/v2',
    SYNC_METADATA: kv,
    REPAIR_AUTH_TOKEN: 'test-repair-token'
  };
  
  return {
    env,
    kv,
    todoistAPI,
    cleanup: () => {
      kv.clear();
      todoistAPI.clear();
    }
  };
}