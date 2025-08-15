import { Env, TodoistTask, TodoistProject, SyncMetadata, TaskMapping, TaskFingerprint } from './types';
import { 
  isSimilarEnough, 
  extractTodoistIdFromDescription,
  addThingsIdToNotes,
  generateContentHash,
  createTaskFingerprint,
  generateRobustHash,
  generateTitleVariations,
  extractThingsIdFromNotes
} from './utils';
import { BatchSyncManager } from './batch-sync';

export class TodoistClient {
  constructor(private env: Env) {}

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async request<T>(endpoint: string, options: RequestInit = {}, retryCount = 0): Promise<T> {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second
    
    try {
      const response = await fetch(`${this.env.TODOIST_API_URL}${endpoint}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });

      if (response.status === 429 && retryCount < maxRetries) {
        // Rate limited - exponential backoff with jitter
        const delay = baseDelay * Math.pow(2, retryCount) + Math.random() * 1000;
        console.log(`Rate limited, retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`);
        await this.sleep(delay);
        return this.request<T>(endpoint, options, retryCount + 1);
      }

      if (!response.ok) {
        // For other errors, retry if transient (5xx errors)
        if (response.status >= 500 && retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          console.log(`Server error ${response.status}, retrying in ${delay}ms`);
          await this.sleep(delay);
          return this.request<T>(endpoint, options, retryCount + 1);
        }
        throw new Error(`Todoist API error: ${response.status} ${response.statusText}`);
      }

      if (response.status === 204) {
        // No content to parse for successful requests
        return undefined as unknown as T;
      }

      return (await response.json()) as T;
    } catch (error) {
      // Network errors - retry with backoff
      if (retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(`Network error, retrying in ${delay}ms:`, error);
        await this.sleep(delay);
        return this.request<T>(endpoint, options, retryCount + 1);
      }
      throw error;
    }
  }

  async getProjects(): Promise<TodoistProject[]> {
    return this.request<TodoistProject[]>('/projects');
  }

  async getInboxProject(): Promise<TodoistProject | undefined> {
    const projects = await this.getProjects();
    return projects.find(p => p.is_inbox_project);
  }

  async getInboxTasks(excludeSynced: boolean = true, kv?: KVNamespace): Promise<TodoistTask[]> {
    const inboxProject = await this.getInboxProject();
    if (!inboxProject) {
      throw new Error('Inbox project not found');
    }

    const tasks = await this.request<TodoistTask[]>(`/tasks?project_id=${inboxProject.id}`);
    let activeTasks = tasks.filter(task => !task.is_completed);
    
    // First, filter by label - this is free and doesn't use KV
    if (excludeSynced) {
      activeTasks = activeTasks.filter(task => {
        // Check if task has the synced label
        const hasSyncedLabel = task.labels.includes('synced-to-things') || 
                               task.labels.includes('synced-from-things');
        // Also check if Things ID is in the description
        const hasThingsId = !!extractThingsIdFromNotes(task.description || '');
        return !hasSyncedLabel && !hasThingsId;
      });
    }
    
    // If KV is available and we still have tasks, do fingerprint check using batch state
    if (excludeSynced && kv && activeTasks.length > 0) {
      const batchSync = new BatchSyncManager({ SYNC_METADATA: kv } as Env);
      await batchSync.loadState();
      
      const syncedTasks = new Set<string>();
      
      // Check fingerprints against batch state
      for (const task of activeTasks) {
        const fingerprint = await createTaskFingerprint(task.content, task.description);
        if (await batchSync.hasMapping(fingerprint.primaryHash)) {
          syncedTasks.add(task.id);
        }
      }
      
      // Legacy mappings by Todoist ID in parallel
      const legacyLookups = await Promise.all(
        activeTasks.map(task => kv.get(`mapping:todoist:${task.id}`))
      );
      
      legacyLookups.forEach((legacyMapping, index) => {
        if (legacyMapping) {
          syncedTasks.add(activeTasks[index].id);
        }
      });
      
      activeTasks = activeTasks.filter(task => !syncedTasks.has(task.id));
    } else if (excludeSynced && !kv) {
      // Fallback to label-based filtering for backward compatibility
      activeTasks = activeTasks.filter(task => !task.labels.includes('synced-to-things'));
    }
    
    return activeTasks;
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.request(`/tasks/${taskId}`, {
      method: 'DELETE',
    });
  }

  async moveTaskToProject(taskId: string, projectId: string): Promise<void> {
    await this.request(`/tasks/${taskId}`, {
      method: 'POST',
      body: JSON.stringify({ project_id: projectId }),
    });
  }

  async addLabelToTask(taskId: string, label: string): Promise<void> {
    const task = await this.request<TodoistTask>(`/tasks/${taskId}`);
    const labels = task.labels.includes(label) ? task.labels : [...task.labels, label];
    
    await this.request(`/tasks/${taskId}`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });
  }

  async createLabelIfNotExists(labelName: string): Promise<void> {
    try {
      const labels = await this.request<Array<{ id: string; name: string }>>('/labels');
      const exists = labels.some(label => label.name === labelName);
      
      if (!exists) {
        await this.request('/labels', {
          method: 'POST',
          body: JSON.stringify({ name: labelName }),
        });
      }
    } catch (error) {
      console.error('Error creating label:', error);
    }
  }

  async createTask(task: {
    content: string;
    description?: string;
    due_date?: string;
    labels?: string[];
  }): Promise<TodoistTask> {
    const inboxProject = await this.getInboxProject();
    if (!inboxProject) {
      throw new Error('Inbox project not found');
    }

    return this.request<TodoistTask>('/tasks', {
      method: 'POST',
      body: JSON.stringify({
        ...task,
        project_id: inboxProject.id,
      }),
    });
  }

  async findTaskByContent(content: string, kv?: KVNamespace): Promise<TodoistTask | undefined> {
    const inboxTasks = await this.getInboxTasks(false, kv);
    return inboxTasks.find(task => task.content === content);
  }

  async findExistingTaskByFingerprint(
    title: string,
    notes?: string,
    due?: string,
    thingsId?: string,
    kv?: KVNamespace
  ): Promise<TaskMapping | null> {
    if (!kv) return null;

    // Use batch sync manager for efficient lookups
    const batchSync = new BatchSyncManager({ SYNC_METADATA: kv } as Env);
    await batchSync.loadState();

    // Create fingerprint for the incoming task
    const fingerprint = await createTaskFingerprint(title, notes, due);

    // 1. Try exact hash lookup first (fastest) - from batch state
    let mapping = await batchSync.getMapping(fingerprint.primaryHash);
    if (mapping) {
      return { ...mapping, source: 'hash' };
    }

    // 2. Check by Things ID if available - from batch state
    if (thingsId) {
      mapping = await batchSync.getMappingByThingsId(thingsId);
      if (mapping) {
        return { ...mapping, source: 'legacy' };
      }
    }

    // 3. Try title variations - from batch state
    for (const titleVariation of fingerprint.titleVariations) {
      const variationHash = await generateRobustHash(titleVariation, notes, due);
      mapping = await batchSync.getMapping(variationHash);
      if (mapping) {
        return { ...mapping, source: 'fuzzy' };
      }
    }

    // 4. Fallback: scan for tasks with similar content (expensive, but thorough)
    const inboxTasks = await this.getInboxTasks(false, kv);
    
    // Check for Things ID in descriptions (legacy support)
    if (thingsId) {
      const taskWithThingsId = inboxTasks.find(task => 
        task.description && task.description.includes(`[things-id:${thingsId}]`)
      );
      if (taskWithThingsId) {
        return {
          todoistId: taskWithThingsId.id,
          thingsId: thingsId,
          fingerprint,
          lastSynced: new Date().toISOString(),
          source: 'legacy'
        };
      }
    }

    // Exact title match
    const exactMatch = inboxTasks.find(task => task.content === title);
    if (exactMatch) {
      return {
        todoistId: exactMatch.id,
        thingsId: thingsId || '',
        fingerprint,
        lastSynced: new Date().toISOString(),
        source: 'exact'
      };
    }

    // Fuzzy title match
    const fuzzyMatch = inboxTasks.find(task => 
      isSimilarEnough(task.content, title, 0.85)
    );
    if (fuzzyMatch) {
      return {
        todoistId: fuzzyMatch.id,
        thingsId: thingsId || '',
        fingerprint,
        lastSynced: new Date().toISOString(),
        source: 'fuzzy'
      };
    }

    return null;
  }

  // Keep the old method for backward compatibility during transition
  async findExistingTask(
    content: string, 
    thingsId?: string,
    kv?: KVNamespace
  ): Promise<{ task: TodoistTask; source: 'exact' | 'fuzzy' | 'metadata' } | null> {
    const mapping = await this.findExistingTaskByFingerprint(content, '', '', thingsId, kv);
    if (!mapping) return null;

    const inboxTasks = await this.getInboxTasks(false, kv);
    const task = inboxTasks.find(t => t.id === mapping.todoistId);
    if (!task) return null;

    return { 
      task, 
      source: mapping.source === 'hash' ? 'metadata' : mapping.source 
    };
  }

  async updateTaskWithThingsId(taskId: string, thingsId: string): Promise<void> {
    const task = await this.request<TodoistTask>(`/tasks/${taskId}`);
    const updatedDescription = addThingsIdToNotes(task.description || '', thingsId);
    
    await this.request(`/tasks/${taskId}`, {
      method: 'POST',
      body: JSON.stringify({ description: updatedDescription }),
    });
  }

  async updateTaskLabels(taskId: string, labels: string[]): Promise<void> {
    await this.request(`/tasks/${taskId}`, {
      method: 'POST',
      body: JSON.stringify({ labels }),
    });
  }

  async closeTask(taskId: string): Promise<boolean> {
    try {
      // First check if task exists and is not already completed
      const task = await this.request<TodoistTask>(`/tasks/${taskId}`);
      
      if (task.is_completed) {
        console.log(`Task ${taskId} is already completed`);
        return true; // Consider already completed as success
      }
      
      await this.request(`/tasks/${taskId}/close`, {
        method: 'POST',
      });
      return true;
    } catch (error) {
      // More detailed error logging
      if (error instanceof Error) {
        console.error(`Failed to close task ${taskId}: ${error.message}`);
        // If task not found (404), it might have been deleted
        if (error.message.includes('404')) {
          console.log(`Task ${taskId} not found, might have been deleted`);
          return true; // Consider deleted task as successfully "closed"
        }
      } else {
        console.error(`Failed to close task ${taskId}:`, error);
      }
      return false;
    }
  }
}