import { Env, TaskMapping } from './types';
import { 
  MobileTask, 
  MobileSyncRequest, 
  MobileSyncResponse, 
  MobileChangesResponse,
  MobileTaskMapping 
} from './mobile-types';
import { BatchSyncManager } from './batch-sync';
import { TodoistClient } from './todoist';
import { createTaskFingerprint } from './utils';
import { MobileAuthManager } from './mobile-auth';
import { MobileBatchManager } from './mobile-batch-manager';

export class MobileSyncManager {
  private batchSync: BatchSyncManager;
  private todoist: TodoistClient;
  private auth: MobileAuthManager;
  private mobileBatch: MobileBatchManager;

  constructor(private env: Env) {
    this.batchSync = new BatchSyncManager(env);
    this.todoist = new TodoistClient(env);
    this.auth = new MobileAuthManager(env);
    this.mobileBatch = new MobileBatchManager(env);
  }

  async processSyncRequest(request: MobileSyncRequest): Promise<MobileSyncResponse> {
    // Verify authentication
    const isValidSignature = await this.auth.verifySignature(
      request.deviceId,
      { changes: request.changes, lastSyncAt: request.lastSyncAt },
      request.signature,
      request.timestamp
    );

    if (!isValidSignature) {
      throw new Error('Invalid signature or expired timestamp');
    }

    // Update device last seen
    await this.auth.updateLastSeen(request.deviceId);

    const conflicts: Array<{ mobileId: string; reason: string; serverTask?: MobileTask }> = [];
    const mappings: Array<{ mobileId: string; thingsId: string }> = [];

    // Process created tasks
    for (const task of request.changes.created) {
      try {
        const result = await this.processCreatedTask(task, request.deviceId);
        if (result.conflict) {
          conflicts.push(result.conflict);
        } else if (result.mapping) {
          mappings.push(result.mapping);
        }
      } catch (error) {
        conflicts.push({
          mobileId: task.id,
          reason: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Process updated tasks
    for (const task of request.changes.updated) {
      try {
        const result = await this.processUpdatedTask(task, request.deviceId);
        if (result.conflict) {
          conflicts.push(result.conflict);
        } else if (result.mapping) {
          mappings.push(result.mapping);
        }
      } catch (error) {
        conflicts.push({
          mobileId: task.id,
          reason: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    // Process completed tasks
    for (const taskId of request.changes.completed) {
      try {
        await this.processCompletedTask(taskId, request.deviceId);
      } catch (error) {
        conflicts.push({
          mobileId: taskId,
          reason: `Failed to complete: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    }

    // Process deleted tasks
    for (const taskId of request.changes.deleted) {
      try {
        await this.processDeletedTask(taskId, request.deviceId);
      } catch (error) {
        conflicts.push({
          mobileId: taskId,
          reason: `Failed to delete: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
      }
    }

    // Flush all changes to KV
    await this.batchSync.flush();
    await this.mobileBatch.flush();

    return {
      success: conflicts.length === 0,
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      mappings,
      serverTime: new Date().toISOString()
    };
  }

  async getChanges(deviceId: string, since: string): Promise<MobileChangesResponse> {
    // Verify device exists
    const device = await this.auth.getDevice(deviceId);
    if (!device) {
      throw new Error('Device not registered');
    }

    await this.auth.updateLastSeen(deviceId);

    // Get mobile task mappings for this device
    const mappings = await this.getDeviceMappings(deviceId);
    const tasks: MobileTask[] = [];
    const tombstones: string[] = [];

    // Get updated tasks from Todoist and convert to mobile format
    const todoistTasks = await this.todoist.getInboxTasks(false, this.env.SYNC_METADATA);
    
    for (const mapping of mappings) {
      if (new Date(mapping.lastSynced) <= new Date(since)) continue;

      const todoistTask = todoistTasks.find(t => t.id === mapping.todoistId);
      if (todoistTask) {
        const mobileTask = this.convertTodoistToMobile(todoistTask, mapping.mobileId);
        if (mobileTask) {
          tasks.push(mobileTask);
        }
      } else {
        // Task might have been deleted
        tombstones.push(mapping.mobileId);
      }
    }

    return {
      tasks,
      tombstones,
      serverTime: new Date().toISOString(),
      hasMore: false // For now, return all changes
    };
  }

  private async processCreatedTask(
    task: MobileTask, 
    deviceId: string
  ): Promise<{ conflict?: any; mapping?: { mobileId: string; thingsId: string } }> {
    // Create fingerprint
    const fingerprint = await createTaskFingerprint(task.title, task.notes, task.due || undefined);

    // Check if task already exists using fingerprint
    const existingMapping = await this.batchSync.getMapping(fingerprint.primaryHash);
    
    if (existingMapping) {
      return {
        conflict: {
          mobileId: task.id,
          reason: 'Task already exists',
          serverTask: await this.getServerTask(existingMapping)
        }
      };
    }

    // Create task in Todoist
    const todoistTask = await this.todoist.createTask({
      content: task.title,
      description: task.notes,
      due_date: task.due || undefined,
      labels: task.labels || []
    });

    // Create mapping
    const taskMapping: TaskMapping = {
      todoistId: todoistTask.id,
      thingsId: `mobile-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, // Placeholder
      fingerprint,
      lastSynced: new Date().toISOString(),
      source: 'exact'
    };

    await this.batchSync.addMapping(taskMapping);

    // Store mobile-specific mapping
    const mobileMapping: MobileTaskMapping = {
      mobileId: task.id,
      todoistId: todoistTask.id,
      thingsId: taskMapping.thingsId,
      fingerprint: fingerprint.primaryHash,
      deviceId,
      createdAt: new Date().toISOString(),
      lastSynced: new Date().toISOString()
    };

    await this.mobileBatch.setTaskMapping(deviceId, task.id, mobileMapping);

    return {
      mapping: {
        mobileId: task.id,
        thingsId: taskMapping.thingsId
      }
    };
  }

  private async processUpdatedTask(
    task: MobileTask,
    deviceId: string
  ): Promise<{ conflict?: any; mapping?: { mobileId: string; thingsId: string } }> {
    const mobileMapping = await this.getMobileMapping(deviceId, task.id);
    if (!mobileMapping) {
      return { conflict: { mobileId: task.id, reason: 'Task mapping not found' } };
    }

    // Update Todoist task
    await this.todoist.request(`/tasks/${mobileMapping.todoistId}`, {
      method: 'POST',
      body: JSON.stringify({
        content: task.title,
        description: task.notes,
        due_date: task.due,
        labels: task.labels || []
      })
    });

    // Update mapping timestamp
    mobileMapping.lastSynced = new Date().toISOString();
    await this.mobileBatch.setTaskMapping(deviceId, task.id, mobileMapping);

    return {
      mapping: {
        mobileId: task.id,
        thingsId: mobileMapping.thingsId || 'pending'
      }
    };
  }

  private async processCompletedTask(taskId: string, deviceId: string): Promise<void> {
    const mobileMapping = await this.getMobileMapping(deviceId, taskId);
    if (!mobileMapping || !mobileMapping.todoistId) return;

    // Complete task in Todoist
    await this.todoist.request(`/tasks/${mobileMapping.todoistId}/close`, {
      method: 'POST'
    });

    // Update mapping
    mobileMapping.lastSynced = new Date().toISOString();
    await this.mobileBatch.setTaskMapping(deviceId, taskId, mobileMapping);
  }

  private async processDeletedTask(taskId: string, deviceId: string): Promise<void> {
    const mobileMapping = await this.getMobileMapping(deviceId, taskId);
    if (!mobileMapping || !mobileMapping.todoistId) return;

    // Delete task from Todoist
    await this.todoist.deleteTask(mobileMapping.todoistId);

    // Remove mappings
    await this.mobileBatch.deleteTaskMapping(deviceId, taskId);
    
    if (mobileMapping.fingerprint) {
      await this.batchSync.removeMapping(mobileMapping.fingerprint);
    }
  }

  private async getMobileMapping(deviceId: string, mobileId: string): Promise<MobileTaskMapping | null> {
    return await this.mobileBatch.getTaskMapping(deviceId, mobileId);
  }

  private async getDeviceMappings(deviceId: string): Promise<MobileTaskMapping[]> {
    const mappingsMap = await this.mobileBatch.getDeviceMappings(deviceId);
    return Array.from(mappingsMap.values());
  }

  private convertTodoistToMobile(todoistTask: any, mobileId: string): MobileTask | null {
    return {
      id: mobileId,
      title: todoistTask.content,
      notes: todoistTask.description || '',
      due: todoistTask.due?.datetime || todoistTask.due?.date || null,
      status: todoistTask.is_completed ? 'completed' : 'open',
      list: 'inbox', // Default mapping
      labels: todoistTask.labels || [],
      createdAt: todoistTask.created_at,
      updatedAt: new Date().toISOString(),
      syncState: 'synced'
    };
  }

  private async getServerTask(mapping: TaskMapping): Promise<MobileTask | undefined> {
    // This would convert server task to mobile format for conflict resolution
    // Implementation depends on how you want to handle conflicts
    return undefined;
  }
}
