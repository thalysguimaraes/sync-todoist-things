import { Env, TodoistTask, TodoistProject } from './types';

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

  async getInboxTasks(excludeSynced: boolean = true): Promise<TodoistTask[]> {
    const inboxProject = await this.getInboxProject();
    if (!inboxProject) {
      throw new Error('Inbox project not found');
    }

    const tasks = await this.request<TodoistTask[]>(`/tasks?project_id=${inboxProject.id}`);
    let activeTasks = tasks.filter(task => !task.is_completed);
    
    // Optionally exclude tasks already synced to Things
    if (excludeSynced) {
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

  async findTaskByContent(content: string): Promise<TodoistTask | undefined> {
    const inboxTasks = await this.getInboxTasks(false);
    return inboxTasks.find(task => task.content === content);
  }
}