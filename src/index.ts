import { Env, ThingsInboxTask, SyncMetadata, CompletedTask, TaskMapping } from './types';
import { TodoistClient } from './todoist';
import { convertToThingsFormat, generateThingsUrl } from './things';
import { 
  acquireSyncLock, 
  releaseSyncLock, 
  generateContentHash,
  extractThingsIdFromNotes,
  addThingsIdToNotes,
  createTaskFingerprint
} from './utils';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const todoist = new TodoistClient(env);

      if (path === '/inbox' && request.method === 'GET') {
        // Get tasks, excluding already synced ones by default
        const includeAll = url.searchParams.get('include_all') === 'true';
        const tasks = await todoist.getInboxTasks(!includeAll, env.SYNC_METADATA);
        
        // Enhance tasks with Things IDs from descriptions
        const enhancedTasks = tasks.map(task => {
          const thingsId = extractThingsIdFromNotes(task.description || '');
          return { ...task, thingsId };
        });
        
        const thingsTasks = convertToThingsFormat(enhancedTasks);
        
        const format = url.searchParams.get('format');
        
        if (format === 'url') {
          const thingsUrl = generateThingsUrl(thingsTasks);
          return new Response(JSON.stringify({ 
            url: thingsUrl, 
            tasks: thingsTasks,
            count: thingsTasks.length,
            filtered: !includeAll,
            taskMappings: enhancedTasks.filter(t => t.thingsId).map(t => ({ 
              todoistId: t.id, 
              thingsId: t.thingsId 
            }))
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        return new Response(JSON.stringify(thingsTasks), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === '/inbox/mark-synced' && request.method === 'POST') {
        // Mark tasks as synced using fingerprint-based tracking
        const tasks = await todoist.getInboxTasks(true, env.SYNC_METADATA); // Get unsynced tasks
        
        const results = await Promise.all(
          tasks.map(async (task) => {
            try {
              // Create fingerprint for the task
              const fingerprint = await createTaskFingerprint(task.content, task.description);
              
              // Create a mapping to mark it as synced to Things (placeholder thingsId)
              const taskMapping: TaskMapping = {
                todoistId: task.id,
                thingsId: `manual-sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                fingerprint,
                lastSynced: new Date().toISOString(),
                source: 'exact'
              };
              
              // Store the mapping
              await env.SYNC_METADATA.put(
                `hash:${fingerprint.primaryHash}`,
                JSON.stringify(taskMapping)
              );
              
              // Also store legacy mapping for backward compatibility
              const legacyMetadata: SyncMetadata = {
                todoistId: task.id,
                thingsId: taskMapping.thingsId,
                lastSynced: new Date().toISOString(),
                contentHash: await generateContentHash(task.content, task.description),
                robustHash: fingerprint.primaryHash,
                fingerprint
              };
              
              await env.SYNC_METADATA.put(
                `mapping:todoist:${task.id}`,
                JSON.stringify(legacyMetadata)
              );
              
              return { id: task.id, content: task.content, status: 'marked_synced' };
            } catch (error) {
              return { id: task.id, status: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
            }
          })
        );
        
        return new Response(JSON.stringify({ results, count: results.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === '/inbox/clear' && request.method === 'POST') {
        const tasks = await todoist.getInboxTasks(false, env.SYNC_METADATA); // Get all tasks including synced
        const deleteMode = url.searchParams.get('mode') || 'fingerprint'; // Default to fingerprint mode
        
        const results = await Promise.all(
          tasks.map(async (task) => {
            try {
              if (deleteMode === 'delete') {
                await todoist.deleteTask(task.id);
                return { id: task.id, status: 'deleted' };
              } else if (deleteMode === 'fingerprint') {
                // Mark as synced using fingerprint tracking
                const fingerprint = await createTaskFingerprint(task.content, task.description);
                
                const taskMapping: TaskMapping = {
                  todoistId: task.id,
                  thingsId: `cleared-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: 'exact'
                };
                
                await env.SYNC_METADATA.put(
                  `hash:${fingerprint.primaryHash}`,
                  JSON.stringify(taskMapping)
                );
                
                return { id: task.id, status: 'marked_synced' };
              } else if (deleteMode === 'move') {
                const projects = await todoist.getProjects();
                let syncedProject = projects.find(p => p.name === 'Synced to Things');
                
                if (!syncedProject) {
                  return { id: task.id, status: 'error', message: 'Synced project not found' };
                }
                
                await todoist.moveTaskToProject(task.id, syncedProject.id);
                return { id: task.id, status: 'moved' };
              } else {
                // Legacy label mode for backward compatibility
                await todoist.addLabelToTask(task.id, 'synced-to-things');
                return { id: task.id, status: 'labeled' };
              }
            } catch (error) {
              return { id: task.id, status: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
            }
          })
        );
        
        return new Response(JSON.stringify({ results, count: results.length }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === '/things/sync' && request.method === 'POST') {
        // Acquire sync lock to prevent concurrent syncs
        const lockAcquired = await acquireSyncLock(env.SYNC_METADATA);
        if (!lockAcquired) {
          return new Response(JSON.stringify({ 
            error: 'Sync already in progress',
            retry_after: 30
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        try {
          // Receive tasks from Things and sync to Todoist
          const thingsTasks = await request.json() as ThingsInboxTask[];
          
          const results = await Promise.all(
            thingsTasks.map(async (task) => {
              try {
                // Check if task already exists using enhanced fingerprint deduplication
                const existingMapping = await todoist.findExistingTaskByFingerprint(
                  task.title,
                  task.notes,
                  task.due,
                  task.id,
                  env.SYNC_METADATA
                );
                
                if (existingMapping) {
                  // Create fingerprint and store updated mapping
                  const fingerprint = await createTaskFingerprint(task.title, task.notes, task.due);
                  
                  const updatedMapping: TaskMapping = {
                    todoistId: existingMapping.todoistId,
                    thingsId: task.id,
                    fingerprint,
                    lastSynced: new Date().toISOString(),
                    source: existingMapping.source
                  };
                  
                  // Store by fingerprint hash (new method)
                  await env.SYNC_METADATA.put(
                    `hash:${fingerprint.primaryHash}`,
                    JSON.stringify(updatedMapping)
                  );
                  
                  // Keep legacy mappings for backward compatibility during transition
                  const legacyMetadata: SyncMetadata = {
                    todoistId: existingMapping.todoistId,
                    thingsId: task.id,
                    lastSynced: new Date().toISOString(),
                    contentHash: await generateContentHash(task.title, task.notes),
                    robustHash: fingerprint.primaryHash,
                    fingerprint
                  };
                  
                  await env.SYNC_METADATA.put(
                    `mapping:things:${task.id}`,
                    JSON.stringify(legacyMetadata)
                  );
                  await env.SYNC_METADATA.put(
                    `mapping:todoist:${existingMapping.todoistId}`,
                    JSON.stringify(legacyMetadata)
                  );
                  
                  return { 
                    id: task.id, 
                    title: task.title, 
                    status: 'already_exists',
                    match_type: existingMapping.source,
                    todoist_id: existingMapping.todoistId 
                  };
                }
                
                // Create new task in Todoist (clean, no labels for sync tracking)
                const taskLabels: string[] = [];
                if (task.tags && task.tags.length > 0) {
                  // Only add actual user tags, not sync tracking labels
                  taskLabels.push(...task.tags);
                }
                
                const newTask = await todoist.createTask({
                  content: task.title,
                  description: task.notes || '',
                  due_date: task.due || undefined,
                  labels: taskLabels,
                });
                
                // Create fingerprint for the new task
                const fingerprint = await createTaskFingerprint(task.title, task.notes, task.due);
                
                // Store mapping using new fingerprint method
                const taskMapping: TaskMapping = {
                  todoistId: newTask.id,
                  thingsId: task.id,
                  fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: 'exact'
                };
                
                await env.SYNC_METADATA.put(
                  `hash:${fingerprint.primaryHash}`,
                  JSON.stringify(taskMapping)
                );
                
                // Keep legacy mappings for backward compatibility
                const legacyMetadata: SyncMetadata = {
                  todoistId: newTask.id,
                  thingsId: task.id,
                  lastSynced: new Date().toISOString(),
                  contentHash: await generateContentHash(task.title, task.notes),
                  robustHash: fingerprint.primaryHash,
                  fingerprint
                };
                
                await env.SYNC_METADATA.put(
                  `mapping:things:${task.id}`,
                  JSON.stringify(legacyMetadata)
                );
                await env.SYNC_METADATA.put(
                  `mapping:todoist:${newTask.id}`,
                  JSON.stringify(legacyMetadata)
                );
                
                return { 
                  id: task.id, 
                  title: task.title, 
                  status: 'created',
                  todoist_id: newTask.id 
                };
              } catch (error) {
                return { 
                  id: task.id, 
                  title: task.title,
                  status: 'error', 
                  message: error instanceof Error ? error.message : 'Unknown error' 
                };
              }
            })
          );
          
          const created = results.filter(r => r.status === 'created').length;
          const existing = results.filter(r => r.status === 'already_exists').length;
          const errors = results.filter(r => r.status === 'error').length;
          
          return new Response(JSON.stringify({ 
            results, 
            summary: { created, existing, errors, total: results.length }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } finally {
          await releaseSyncLock(env.SYNC_METADATA);
        }
      }

      if (path === '/things/sync-completed' && request.method === 'POST') {
        try {
          // Receive completed tasks from Things
          const completedTasks = await request.json() as CompletedTask[];
          
          const results = await Promise.all(
            completedTasks.map(async (task) => {
              try {
                // Look up the Todoist ID from our KV mapping
                let metadata = await env.SYNC_METADATA.get(`mapping:things:${task.thingsId}`);
                
                // If not found in KV, try to find by extracting Todoist ID from notes
                if (!metadata) {
                  try {
                    const allTasks = await todoist.getInboxTasks(false, env.SYNC_METADATA);
                    const matchingTask = allTasks.find(t => 
                      t.description && t.description.includes(`[things-id:${task.thingsId}]`)
                    );
                    
                    if (matchingTask) {
                      // Create missing metadata entry
                      const newMetadata: SyncMetadata = {
                        todoistId: matchingTask.id,
                        thingsId: task.thingsId,
                        lastSynced: new Date().toISOString()
                      };
                      
                      await env.SYNC_METADATA.put(
                        `mapping:things:${task.thingsId}`,
                        JSON.stringify(newMetadata)
                      );
                      await env.SYNC_METADATA.put(
                        `mapping:todoist:${matchingTask.id}`,
                        JSON.stringify(newMetadata)
                      );
                      
                      metadata = JSON.stringify(newMetadata);
                    }
                  } catch (findError) {
                    console.error('Error finding task by Things ID:', findError);
                  }
                }
                
                if (!metadata) {
                  return {
                    thingsId: task.thingsId,
                    status: 'not_found',
                    message: 'No Todoist mapping found'
                  };
                }
                
                const { todoistId } = JSON.parse(metadata) as SyncMetadata;
                
                // Close the task in Todoist with retry logic
                let retryCount = 0;
                let success = false;
                
                while (retryCount < 3 && !success) {
                  success = await todoist.closeTask(todoistId);
                  if (!success) {
                    retryCount++;
                    await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // exponential backoff
                  }
                }
                
                if (success) {
                  // Update metadata with completion time
                  const updatedMetadata: SyncMetadata = {
                    ...JSON.parse(metadata),
                    lastSynced: new Date().toISOString()
                  };
                  
                  await env.SYNC_METADATA.put(
                    `mapping:things:${task.thingsId}`,
                    JSON.stringify(updatedMetadata)
                  );
                  await env.SYNC_METADATA.put(
                    `mapping:todoist:${todoistId}`,
                    JSON.stringify(updatedMetadata)
                  );
                  
                  return {
                    thingsId: task.thingsId,
                    todoistId,
                    status: 'completed',
                    completedAt: task.completedAt
                  };
                } else {
                  return {
                    thingsId: task.thingsId,
                    todoistId,
                    status: 'error',
                    message: 'Failed to close task in Todoist'
                  };
                }
              } catch (error) {
                return {
                  thingsId: task.thingsId,
                  status: 'error',
                  message: error instanceof Error ? error.message : 'Unknown error'
                };
              }
            })
          );
          
          const completed = results.filter(r => r.status === 'completed').length;
          const notFound = results.filter(r => r.status === 'not_found').length;
          const errors = results.filter(r => r.status === 'error').length;
          
          return new Response(JSON.stringify({
            results,
            summary: { completed, notFound, errors, total: results.length }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('Error syncing completed tasks:', error);
          return new Response(JSON.stringify({
            error: 'Failed to sync completed tasks',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/sync/status' && request.method === 'GET') {
        const lockKey = 'sync:lock';
        const lockData = await env.SYNC_METADATA.get(lockKey);
        const isLocked = lockData ? JSON.parse(lockData).timestamp > Date.now() - 30000 : false;
        
        // Get comprehensive stats
        const mappingsList = await env.SYNC_METADATA.list({ prefix: 'mapping:' });
        const hashList = await env.SYNC_METADATA.list({ prefix: 'hash:' });
        
        const thingsMappings = mappingsList.keys.filter(k => k.name.startsWith('mapping:things:')).length;
        const todoistMappings = mappingsList.keys.filter(k => k.name.startsWith('mapping:todoist:')).length;
        
        // Analyze migration status
        let migratedMappings = 0;
        let pendingMigration = 0;
        
        for (const key of mappingsList.keys) {
          try {
            const metadata = await env.SYNC_METADATA.get(key.name);
            if (metadata) {
              const syncMetadata = JSON.parse(metadata) as SyncMetadata;
              if (syncMetadata.fingerprint && syncMetadata.robustHash) {
                migratedMappings++;
              } else {
                pendingMigration++;
              }
            }
          } catch (error) {
            // Skip invalid entries
          }
        }

        // Check Todoist tasks with sync labels
        const allTasks = await todoist.getInboxTasks(false, env.SYNC_METADATA);
        const taggedTasks = allTasks.filter(task => 
          task.labels.includes('synced-to-things') || 
          task.labels.includes('synced-from-things')
        );

        let taggedTasksWithFingerprints = 0;
        for (const task of taggedTasks) {
          try {
            const fingerprint = await createTaskFingerprint(task.content, task.description);
            const hashMapping = await env.SYNC_METADATA.get(`hash:${fingerprint.primaryHash}`);
            if (hashMapping) {
              taggedTasksWithFingerprints++;
            }
          } catch (error) {
            // Skip errors
          }
        }
        
        return new Response(JSON.stringify({ 
          syncLocked: isLocked,
          legacy: {
            mappings: {
              things: thingsMappings,
              todoist: todoistMappings,
              total: mappingsList.keys.length
            },
            taggedTasks: {
              total: taggedTasks.length,
              withFingerprints: taggedTasksWithFingerprints,
              pendingMigration: taggedTasks.length - taggedTasksWithFingerprints
            }
          },
          fingerprint: {
            hashMappings: hashList.keys.length,
            migratedLegacyMappings: migratedMappings,
            pendingLegacyMigration: pendingMigration
          },
          migration: {
            progress: mappingsList.keys.length > 0 ? (migratedMappings / mappingsList.keys.length * 100).toFixed(1) + '%' : '0%',
            isComplete: pendingMigration === 0 && (taggedTasks.length - taggedTasksWithFingerprints) === 0,
            recommendations: [
              ...(pendingMigration > 0 ? ['Run POST /migrate to migrate legacy mappings'] : []),
              ...((taggedTasks.length - taggedTasksWithFingerprints) > 0 ? ['Run POST /migrate to migrate tagged tasks'] : []),
              ...(pendingMigration === 0 && (taggedTasks.length - taggedTasksWithFingerprints) === 0 ? ['Migration complete! System ready for tag-free operation'] : [])
            ]
          },
          timestamp: new Date().toISOString()
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === '/migrate' && request.method === 'POST') {
        // Migrate existing tag-based tasks to fingerprint system
        try {
          const results = {
            todoistTasks: { processed: 0, migrated: 0, errors: 0 },
            legacyMappings: { processed: 0, migrated: 0, errors: 0 },
            summary: []
          };

          // 1. Migrate Todoist tasks with sync labels
          const allTasks = await todoist.getInboxTasks(false); // Get all tasks
          const taggedTasks = allTasks.filter(task => 
            task.labels.includes('synced-to-things') || 
            task.labels.includes('synced-from-things')
          );

          for (const task of taggedTasks) {
            results.todoistTasks.processed++;
            try {
              // Check if already migrated
              const fingerprint = await createTaskFingerprint(task.content, task.description);
              let existing = await env.SYNC_METADATA.get(`hash:${fingerprint.primaryHash}`);
              
              if (!existing) {
                // Create new fingerprint mapping
                const taskMapping: TaskMapping = {
                  todoistId: task.id,
                  thingsId: `migrated-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: 'legacy'
                };

                await env.SYNC_METADATA.put(
                  `hash:${fingerprint.primaryHash}`,
                  JSON.stringify(taskMapping)
                );

                results.todoistTasks.migrated++;
                results.summary.push(`Migrated Todoist task: ${task.content.substring(0, 50)}...`);
                existing = JSON.stringify(taskMapping);
              }

              // Remove old sync labels from the task (clean up UI)
              if (existing) {
                const currentLabels = task.labels.filter(label => 
                  label !== 'synced-to-things' && 
                  label !== 'synced-from-things'
                );

                // Only update if labels changed
                if (currentLabels.length !== task.labels.length) {
                  await todoist.request(`/tasks/${task.id}`, {
                    method: 'POST',
                    body: JSON.stringify({ labels: currentLabels }),
                  });
                  results.summary.push(`Cleaned tags from: ${task.content.substring(0, 40)}...`);
                }
              }
            } catch (error) {
              results.todoistTasks.errors++;
              results.summary.push(`Error migrating Todoist task ${task.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }

          // 2. Migrate existing KV mappings to new format
          const mappingsList = await env.SYNC_METADATA.list({ prefix: 'mapping:' });
          
          for (const key of mappingsList.keys) {
            results.legacyMappings.processed++;
            try {
              const metadata = await env.SYNC_METADATA.get(key.name);
              if (!metadata) continue;

              const syncMetadata = JSON.parse(metadata) as SyncMetadata;
              
              // Skip if already has fingerprint
              if (syncMetadata.fingerprint && syncMetadata.robustHash) {
                continue;
              }

              // Get task details to create fingerprint
              let taskContent = '';
              let taskDescription = '';
              
              if (key.name.startsWith('mapping:todoist:')) {
                const task = allTasks.find(t => t.id === syncMetadata.todoistId);
                if (task) {
                  taskContent = task.content;
                  taskDescription = task.description || '';
                }
              }

              if (taskContent) {
                const fingerprint = await createTaskFingerprint(taskContent, taskDescription);
                
                // Check if hash mapping already exists
                const hashMapping = await env.SYNC_METADATA.get(`hash:${fingerprint.primaryHash}`);
                
                if (!hashMapping) {
                  const taskMapping: TaskMapping = {
                    todoistId: syncMetadata.todoistId,
                    thingsId: syncMetadata.thingsId,
                    fingerprint,
                    lastSynced: syncMetadata.lastSynced,
                    source: 'legacy'
                  };

                  await env.SYNC_METADATA.put(
                    `hash:${fingerprint.primaryHash}`,
                    JSON.stringify(taskMapping)
                  );

                  // Update legacy mapping with fingerprint info
                  const updatedMetadata: SyncMetadata = {
                    ...syncMetadata,
                    robustHash: fingerprint.primaryHash,
                    fingerprint
                  };

                  await env.SYNC_METADATA.put(key.name, JSON.stringify(updatedMetadata));

                  results.legacyMappings.migrated++;
                  results.summary.push(`Migrated legacy mapping: ${key.name}`);
                }
              }
            } catch (error) {
              results.legacyMappings.errors++;
              results.summary.push(`Error migrating ${key.name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }

          return new Response(JSON.stringify(results), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Migration failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/cleanup-tags' && request.method === 'POST') {
        // Clean up sync tags from tasks that are already migrated to fingerprint system
        try {
          const results = {
            processed: 0,
            cleaned: 0,
            errors: 0,
            summary: []
          };

          // Get all tasks with sync tags
          const allTasks = await todoist.getInboxTasks(false); // Get all tasks
          const taggedTasks = allTasks.filter(task => 
            task.labels.includes('synced-to-things') || 
            task.labels.includes('synced-from-things')
          );

          for (const task of taggedTasks) {
            results.processed++;
            try {
              // Check if task is already in fingerprint system
              const fingerprint = await createTaskFingerprint(task.content, task.description);
              const existing = await env.SYNC_METADATA.get(`hash:${fingerprint.primaryHash}`);
              
              if (existing) {
                // Remove sync labels since task is tracked by fingerprint
                const cleanLabels = task.labels.filter(label => 
                  label !== 'synced-to-things' && 
                  label !== 'synced-from-things'
                );

                if (cleanLabels.length !== task.labels.length) {
                  await todoist.request(`/tasks/${task.id}`, {
                    method: 'POST',
                    body: JSON.stringify({ labels: cleanLabels }),
                  });

                  results.cleaned++;
                  results.summary.push(`Cleaned: ${task.content.substring(0, 50)}...`);
                } else {
                  results.summary.push(`No tags to clean: ${task.content.substring(0, 40)}...`);
                }
              } else {
                results.summary.push(`Not migrated yet: ${task.content.substring(0, 40)}...`);
              }
            } catch (error) {
              results.errors++;
              results.summary.push(`Error cleaning ${task.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }

          return new Response(JSON.stringify(results), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Tag cleanup failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/health' && request.method === 'GET') {
        return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ 
        error: 'Internal server error', 
        message: error instanceof Error ? error.message : 'Unknown error' 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  },
};