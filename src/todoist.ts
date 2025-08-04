import { Env, TodoistTask, TodoistProject, SyncMetadata, TaskMapping, TaskFingerprint } from './types';
import { 
  isSimilarEnough, 
  extractTodoistIdFromDescription,
  addThingsIdToNotes,
  generateContentHash,
  createTaskFingerprint,
  generateRobustHash,
  generateTitleVariations
} from './utils';

export class TodoistClient {
  constructor(private env: Env) {}

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.env.TODOIST_API_URL}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Todoist API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
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
    
    // If fingerprint-based exclusion is requested and KV is available
    if (excludeSynced && kv) {
      const syncedTasks = new Set<string>();
      
      // Check KV for synced tasks using new hash-based system
      for (const task of activeTasks) {
        const fingerprint = await createTaskFingerprint(task.content, task.description);
        const mapping = await kv.get(`hash:${fingerprint.primaryHash}`);
        if (mapping) {
          syncedTasks.add(task.id);
          continue;
        }
        
        // Legacy check: look for tasks in mapping by Todoist ID
        const legacyMapping = await kv.get(`mapping:todoist:${task.id}`);
        if (legacyMapping) {
          syncedTasks.add(task.id);
        }
      }
      
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

    // Create fingerprint for the incoming task
    const fingerprint = await createTaskFingerprint(title, notes, due);

    // 1. Try exact hash lookup first (fastest)
    let mapping = await kv.get(`hash:${fingerprint.primaryHash}`);
    if (mapping) {
      const taskMapping = JSON.parse(mapping) as TaskMapping;
      return { ...taskMapping, source: 'hash' };
    }

    // 2. Check legacy mapping by Things ID
    if (thingsId) {
      const legacyMapping = await kv.get(`mapping:things:${thingsId}`);
      if (legacyMapping) {
        const metadata = JSON.parse(legacyMapping) as SyncMetadata;
        return {
          todoistId: metadata.todoistId,
          thingsId: metadata.thingsId,
          fingerprint,
          lastSynced: metadata.lastSynced,
          source: 'legacy'
        };
      }
    }

    // 3. Try title variations
    for (const titleVariation of fingerprint.titleVariations) {
      const variationHash = await generateRobustHash(titleVariation, notes, due);
      mapping = await kv.get(`hash:${variationHash}`);
      if (mapping) {
        const taskMapping = JSON.parse(mapping) as TaskMapping;
        return { ...taskMapping, source: 'fuzzy' };
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