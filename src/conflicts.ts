import { 
  TaskMapping, 
  SyncConflict, 
  ConflictResolutionStrategy,
  SyncConfig,
  ThingsInboxTask,
  TodoistTask
} from './types';
import { createTaskFingerprint } from './utils';

export class ConflictResolver {
  private config: SyncConfig;

  constructor(config?: Partial<SyncConfig>) {
    this.config = {
      conflictStrategy: 'newest_wins',
      autoResolveConflicts: true,
      ...config
    };
  }

  /**
   * Detect if there's a conflict between current states and last synced state
   */
  async detectConflict(
    todoistTask: TodoistTask,
    thingsTask: ThingsInboxTask,
    lastMapping: TaskMapping
  ): Promise<SyncConflict | null> {
    // If no last synced content, no conflict possible
    if (!lastMapping.lastSyncedContent) {
      return null;
    }

    const lastContent = lastMapping.lastSyncedContent;
    
    // Check if Todoist version changed
    const todoistChanged = 
      todoistTask.content !== lastContent.title ||
      (todoistTask.description || '') !== (lastContent.notes || '') ||
      this.formatDue(todoistTask.due) !== lastContent.due;

    // Check if Things version changed  
    const thingsChanged =
      thingsTask.title !== lastContent.title ||
      (thingsTask.notes || '') !== (lastContent.notes || '') ||
      thingsTask.due !== lastContent.due;

    // If both changed, we have a conflict
    if (todoistChanged && thingsChanged) {
      return {
        id: `conflict-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        todoistId: todoistTask.id,
        thingsId: thingsTask.id,
        detectedAt: new Date().toISOString(),
        todoistVersion: {
          title: todoistTask.content,
          notes: todoistTask.description,
          due: this.formatDue(todoistTask.due),
          labels: todoistTask.labels,
          modifiedAt: lastMapping.todoistModifiedAt
        },
        thingsVersion: {
          title: thingsTask.title,
          notes: thingsTask.notes,
          due: thingsTask.due,
          tags: thingsTask.tags,
          modifiedAt: lastMapping.thingsModifiedAt
        },
        lastSyncedVersion: lastContent,
        suggestedResolution: this.suggestResolution(
          todoistTask,
          thingsTask,
          lastMapping
        ),
        resolved: false
      };
    }

    return null;
  }

  /**
   * Suggest a resolution strategy based on the conflict
   */
  private suggestResolution(
    todoistTask: TodoistTask,
    thingsTask: ThingsInboxTask,
    lastMapping: TaskMapping
  ): ConflictResolutionStrategy {
    // If we have modification timestamps, use newest_wins
    if (lastMapping.todoistModifiedAt && lastMapping.thingsModifiedAt) {
      const todoistTime = new Date(lastMapping.todoistModifiedAt).getTime();
      const thingsTime = new Date(lastMapping.thingsModifiedAt).getTime();
      
      if (Math.abs(todoistTime - thingsTime) > 60000) { // More than 1 minute difference
        return 'newest_wins';
      }
    }

    // If changes are complementary (different fields), suggest merge
    const todoistChangedTitle = todoistTask.content !== lastMapping.lastSyncedContent?.title;
    const thingsChangedNotes = thingsTask.notes !== lastMapping.lastSyncedContent?.notes;
    
    if (todoistChangedTitle && !thingsChangedNotes) {
      return 'todoist_wins';
    }
    if (!todoistChangedTitle && thingsChangedNotes) {
      return 'things_wins';
    }
    if (this.canMergeChanges(todoistTask, thingsTask, lastMapping)) {
      return 'merge';
    }

    // Default to configured strategy
    return this.config.conflictStrategy;
  }

  /**
   * Check if changes can be merged without conflict
   */
  private canMergeChanges(
    todoistTask: TodoistTask,
    thingsTask: ThingsInboxTask,
    lastMapping: TaskMapping
  ): boolean {
    if (!lastMapping.lastSyncedContent) return false;

    const lastContent = lastMapping.lastSyncedContent;
    
    // Check if changes are to different fields
    const todoistFields = {
      title: todoistTask.content !== lastContent.title,
      notes: (todoistTask.description || '') !== (lastContent.notes || ''),
      due: this.formatDue(todoistTask.due) !== lastContent.due
    };

    const thingsFields = {
      title: thingsTask.title !== lastContent.title,
      notes: (thingsTask.notes || '') !== (lastContent.notes || ''),
      due: thingsTask.due !== lastContent.due
    };

    // Can merge if they changed different fields
    for (const field of ['title', 'notes', 'due'] as const) {
      if (todoistFields[field] && thingsFields[field]) {
        return false; // Both changed the same field
      }
    }

    return true;
  }

  /**
   * Resolve a conflict using the specified strategy
   */
  async resolveConflict(
    conflict: SyncConflict,
    strategy?: ConflictResolutionStrategy
  ): Promise<{
    resolvedTask: Partial<TodoistTask & ThingsInboxTask>;
    appliedStrategy: ConflictResolutionStrategy;
  }> {
    const resolveStrategy = strategy || conflict.suggestedResolution || this.config.conflictStrategy;

    switch (resolveStrategy) {
      case 'todoist_wins':
        return {
          resolvedTask: {
            title: conflict.todoistVersion.title,
            content: conflict.todoistVersion.title,
            notes: conflict.todoistVersion.notes,
            description: conflict.todoistVersion.notes,
            due: conflict.todoistVersion.due,
            labels: conflict.todoistVersion.labels,
            tags: conflict.todoistVersion.labels
          },
          appliedStrategy: 'todoist_wins'
        };

      case 'things_wins':
        return {
          resolvedTask: {
            title: conflict.thingsVersion.title,
            content: conflict.thingsVersion.title,
            notes: conflict.thingsVersion.notes,
            description: conflict.thingsVersion.notes,
            due: conflict.thingsVersion.due,
            labels: conflict.thingsVersion.tags,
            tags: conflict.thingsVersion.tags
          },
          appliedStrategy: 'things_wins'
        };

      case 'newest_wins':
        const todoistTime = conflict.todoistVersion.modifiedAt ? 
          new Date(conflict.todoistVersion.modifiedAt).getTime() : 0;
        const thingsTime = conflict.thingsVersion.modifiedAt ?
          new Date(conflict.thingsVersion.modifiedAt).getTime() : 0;
        
        if (todoistTime >= thingsTime) {
          return this.resolveConflict(conflict, 'todoist_wins');
        } else {
          return this.resolveConflict(conflict, 'things_wins');
        }

      case 'merge':
        return this.mergeChanges(conflict);

      case 'manual':
        throw new Error('Manual conflict resolution required');

      default:
        return this.resolveConflict(conflict, 'newest_wins');
    }
  }

  /**
   * Merge non-conflicting changes from both versions
   */
  private async mergeChanges(conflict: SyncConflict): Promise<{
    resolvedTask: Partial<TodoistTask & ThingsInboxTask>;
    appliedStrategy: ConflictResolutionStrategy;
  }> {
    const lastVersion = conflict.lastSyncedVersion || {};
    const merged: Partial<TodoistTask & ThingsInboxTask> = {};

    // Merge title - take the one that changed
    if (conflict.todoistVersion.title !== lastVersion.title) {
      merged.title = conflict.todoistVersion.title;
      merged.content = conflict.todoistVersion.title;
    } else if (conflict.thingsVersion.title !== lastVersion.title) {
      merged.title = conflict.thingsVersion.title;
      merged.content = conflict.thingsVersion.title;
    } else {
      merged.title = conflict.todoistVersion.title;
      merged.content = conflict.todoistVersion.title;
    }

    // Merge notes - take the one that changed or combine if both changed
    if (conflict.todoistVersion.notes !== lastVersion.notes && 
        conflict.thingsVersion.notes !== lastVersion.notes) {
      // Both changed - combine with separator
      merged.notes = `${conflict.todoistVersion.notes}\n---\n${conflict.thingsVersion.notes}`;
      merged.description = merged.notes;
    } else if (conflict.todoistVersion.notes !== lastVersion.notes) {
      merged.notes = conflict.todoistVersion.notes;
      merged.description = conflict.todoistVersion.notes;
    } else if (conflict.thingsVersion.notes !== lastVersion.notes) {
      merged.notes = conflict.thingsVersion.notes;
      merged.description = conflict.thingsVersion.notes;
    } else {
      merged.notes = conflict.todoistVersion.notes;
      merged.description = conflict.todoistVersion.notes;
    }

    // Merge due date - take the one that changed or the earliest if both changed
    if (conflict.todoistVersion.due !== lastVersion.due && 
        conflict.thingsVersion.due !== lastVersion.due) {
      // Both changed - take the earliest
      const todoistDue = conflict.todoistVersion.due ? new Date(conflict.todoistVersion.due) : null;
      const thingsDue = conflict.thingsVersion.due ? new Date(conflict.thingsVersion.due) : null;
      
      if (todoistDue && thingsDue) {
        merged.due = todoistDue <= thingsDue ? conflict.todoistVersion.due : conflict.thingsVersion.due;
      } else {
        merged.due = conflict.todoistVersion.due || conflict.thingsVersion.due;
      }
    } else if (conflict.todoistVersion.due !== lastVersion.due) {
      merged.due = conflict.todoistVersion.due;
    } else if (conflict.thingsVersion.due !== lastVersion.due) {
      merged.due = conflict.thingsVersion.due;
    } else {
      merged.due = conflict.todoistVersion.due;
    }

    // Merge tags/labels - union of both
    const allTags = new Set([
      ...(conflict.todoistVersion.labels || []),
      ...(conflict.thingsVersion.tags || [])
    ]);
    merged.labels = Array.from(allTags);
    merged.tags = Array.from(allTags);

    return {
      resolvedTask: merged,
      appliedStrategy: 'merge'
    };
  }

  /**
   * Format Todoist due date to standard format
   */
  private formatDue(due?: TodoistTask['due']): string | undefined {
    if (!due) return undefined;
    return due.datetime || due.date;
  }

  /**
   * Store conflict for manual resolution
   */
  async storeConflict(conflict: SyncConflict, kv: KVNamespace): Promise<void> {
    const key = `conflict:${conflict.id}`;
    await kv.put(key, JSON.stringify(conflict), {
      expirationTtl: 86400 * 7 // Keep conflicts for 7 days
    });

    // Also store in a list for easy retrieval
    const listKey = 'conflicts:unresolved';
    const existingList = await kv.get(listKey);
    const conflictIds = existingList ? JSON.parse(existingList) : [];
    
    if (!conflictIds.includes(conflict.id)) {
      conflictIds.push(conflict.id);
      await kv.put(listKey, JSON.stringify(conflictIds));
    }
  }

  /**
   * Get all unresolved conflicts
   */
  async getUnresolvedConflicts(kv: KVNamespace): Promise<SyncConflict[]> {
    const listKey = 'conflicts:unresolved';
    const existingList = await kv.get(listKey);
    
    if (!existingList) return [];
    
    const conflictIds = JSON.parse(existingList) as string[];
    const conflicts: SyncConflict[] = [];
    
    for (const id of conflictIds) {
      const conflictData = await kv.get(`conflict:${id}`);
      if (conflictData) {
        conflicts.push(JSON.parse(conflictData) as SyncConflict);
      }
    }
    
    return conflicts.filter(c => !c.resolved);
  }

  /**
   * Mark conflict as resolved
   */
  async markConflictResolved(conflictId: string, kv: KVNamespace): Promise<void> {
    const key = `conflict:${conflictId}`;
    const conflictData = await kv.get(key);
    
    if (conflictData) {
      const conflict = JSON.parse(conflictData) as SyncConflict;
      conflict.resolved = true;
      await kv.put(key, JSON.stringify(conflict));
      
      // Remove from unresolved list
      const listKey = 'conflicts:unresolved';
      const existingList = await kv.get(listKey);
      if (existingList) {
        const conflictIds = JSON.parse(existingList) as string[];
        const filtered = conflictIds.filter(id => id !== conflictId);
        await kv.put(listKey, JSON.stringify(filtered));
      }
    }
  }
}