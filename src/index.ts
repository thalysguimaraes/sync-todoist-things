import { Env, ThingsInboxTask, SyncMetadata } from './types';
import { TodoistClient } from './todoist';
import { convertToThingsFormat, generateThingsUrl } from './things';
import { 
  acquireSyncLock, 
  releaseSyncLock, 
  generateContentHash,
  extractThingsIdFromNotes,
  addThingsIdToNotes 
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
        const tasks = await todoist.getInboxTasks(!includeAll);
        
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
        // Mark tasks as synced without deleting them
        const tasks = await todoist.getInboxTasks(true); // Get unsynced tasks
        
        // Ensure the label exists
        await todoist.createLabelIfNotExists('synced-to-things');
        
        const results = await Promise.all(
          tasks.map(async (task) => {
            try {
              await todoist.addLabelToTask(task.id, 'synced-to-things');
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
        const tasks = await todoist.getInboxTasks(false); // Get all tasks including synced
        const deleteMode = url.searchParams.get('mode') || 'label'; // Default to label mode
        
        const results = await Promise.all(
          tasks.map(async (task) => {
            try {
              if (deleteMode === 'delete') {
                await todoist.deleteTask(task.id);
                return { id: task.id, status: 'deleted' };
              } else if (deleteMode === 'label') {
                await todoist.addLabelToTask(task.id, 'synced-to-things');
                return { id: task.id, status: 'labeled' };
              } else {
                const projects = await todoist.getProjects();
                let syncedProject = projects.find(p => p.name === 'Synced to Things');
                
                if (!syncedProject) {
                  return { id: task.id, status: 'error', message: 'Synced project not found' };
                }
                
                await todoist.moveTaskToProject(task.id, syncedProject.id);
                return { id: task.id, status: 'moved' };
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
          
          // Ensure labels exist
          await todoist.createLabelIfNotExists('synced-from-things');
          
          const results = await Promise.all(
            thingsTasks.map(async (task) => {
              try {
                // Check if task already exists using enhanced deduplication
                const existingResult = await todoist.findExistingTask(
                  task.title,
                  task.id,
                  env.SYNC_METADATA
                );
                
                if (existingResult) {
                  // Update metadata if needed
                  const metadata: SyncMetadata = {
                    todoistId: existingResult.task.id,
                    thingsId: task.id,
                    lastSynced: new Date().toISOString(),
                    contentHash: await generateContentHash(task.title, task.notes)
                  };
                  
                  await env.SYNC_METADATA.put(
                    `mapping:things:${task.id}`,
                    JSON.stringify(metadata)
                  );
                  await env.SYNC_METADATA.put(
                    `mapping:todoist:${existingResult.task.id}`,
                    JSON.stringify(metadata)
                  );
                  
                  return { 
                    id: task.id, 
                    title: task.title, 
                    status: 'already_exists',
                    match_type: existingResult.source,
                    todoist_id: existingResult.task.id 
                  };
                }
                
                // Create new task in Todoist with Things ID in description
                const labels = ['synced-from-things'];
                if (task.tags && task.tags.length > 0) {
                  labels.push(...task.tags);
                }
                
                const descriptionWithId = addThingsIdToNotes(
                  task.notes || '',
                  task.id
                );
                
                const newTask = await todoist.createTask({
                  content: task.title,
                  description: descriptionWithId,
                  due_date: task.due || undefined,
                  labels,
                });
                
                // Store mapping in KV
                const metadata: SyncMetadata = {
                  todoistId: newTask.id,
                  thingsId: task.id,
                  lastSynced: new Date().toISOString(),
                  contentHash: generateContentHash(task.title, task.notes)
                };
                
                await env.SYNC_METADATA.put(
                  `mapping:things:${task.id}`,
                  JSON.stringify(metadata)
                );
                await env.SYNC_METADATA.put(
                  `mapping:todoist:${newTask.id}`,
                  JSON.stringify(metadata)
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

      if (path === '/sync/status' && request.method === 'GET') {
        const lockKey = 'sync:lock';
        const lockData = await env.SYNC_METADATA.get(lockKey);
        const isLocked = lockData ? JSON.parse(lockData).timestamp > Date.now() - 30000 : false;
        
        // Get some stats
        const mappingsList = await env.SYNC_METADATA.list({ prefix: 'mapping:' });
        const thingsMappings = mappingsList.keys.filter(k => k.name.startsWith('mapping:things:')).length;
        const todoistMappings = mappingsList.keys.filter(k => k.name.startsWith('mapping:todoist:')).length;
        
        return new Response(JSON.stringify({ 
          syncLocked: isLocked,
          mappings: {
            things: thingsMappings,
            todoist: todoistMappings,
            total: mappingsList.keys.length
          },
          timestamp: new Date().toISOString()
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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