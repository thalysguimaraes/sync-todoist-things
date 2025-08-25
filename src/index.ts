import { 
  Env, 
  ThingsInboxTask, 
  SyncMetadata, 
  CompletedTask, 
  TaskMapping, 
  IdempotencyRecord,
  SyncConflict,
  ConflictResolutionStrategy,
  SyncConfig,
  TodoistTask,
  ScheduledEvent,
  BatchSyncState
} from './types';
import { D1KV } from './storage/d1-kv';
import { MobileSyncRequest } from './mobile-types';
import { MobileAuthManager } from './mobile-auth';
import { MobileSyncManager } from './mobile-sync';
import { BatchSyncManager } from './batch-sync';
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
import { MetricsTracker } from './metrics';
import { ConflictResolver } from './conflicts';
import { ConfigManager } from './config';
import { WebhookDispatcher } from './webhooks/dispatcher';
import { KVMigrationManager } from './migration/kv-migration';
import { WebhookSource, OutboundWebhookPayload, OutboundWebhookEvent } from './webhooks/types';

// Helper function to send outbound webhooks
async function sendOutboundWebhook(
  env: Env,
  event: OutboundWebhookEvent,
  data: any
): Promise<void> {
  try {
    const subscribers = await env.SYNC_METADATA.get('outbound-webhooks');
    if (!subscribers) return;

    const webhookSubscribers = JSON.parse(subscribers);
    
    for (const subscriber of webhookSubscribers) {
      if (subscriber.enabled && subscriber.events.includes(event)) {
        const payload: OutboundWebhookPayload = {
          event,
          timestamp: new Date().toISOString(),
          data
        };

        // Add signature if secret is configured
        if (subscriber.secret) {
          const hmac = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(subscriber.secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
          );
          const signature = await crypto.subtle.sign(
            'HMAC', 
            hmac, 
            new TextEncoder().encode(JSON.stringify(payload))
          );
          payload.signature = Array.from(new Uint8Array(signature))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        }

        // Send webhook (fire and forget)
        fetch(subscriber.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Todoist-Things-Sync/1.0'
          },
          body: JSON.stringify(payload)
        }).catch(error => {
          console.error(`Webhook delivery failed to ${subscriber.url}:`, error);
          
          // Store delivery failure for monitoring
          const delivery = {
            id: `delivery-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            webhookUrl: subscriber.url,
            event,
            payload,
            status: 'failed',
            attempts: 1,
            error: error.message,
            createdAt: new Date().toISOString()
          };

          env.SYNC_METADATA.put(
            `webhook-delivery:${delivery.id}`, 
            JSON.stringify(delivery),
            { expirationTtl: 86400 } // Keep for 24 hours
          ).catch(console.error);
        });
      }
    }
  } catch (error) {
    console.error('Outbound webhook error:', error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Override KV with D1-backed adapter
    const d1kv = new D1KV(env.DB);
    env = { ...env, SYNC_METADATA: d1kv as unknown as KVNamespace };
    
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
      const metrics = new MetricsTracker(env);

      // Mobile sync endpoints
      if (path === '/mobile/register' && request.method === 'POST') {
        const mobileAuth = new MobileAuthManager(env);
        
        try {
          const body = await request.json().catch(() => ({})) as { platform?: string; appVersion?: string };
          const registration = await mobileAuth.registerDevice(
            body.platform,
            body.appVersion
          );

          return new Response(JSON.stringify({
            deviceId: registration.deviceId,
            secret: registration.secret,
            registeredAt: registration.registeredAt
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Registration failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/mobile/sync' && request.method === 'POST') {
        const mobileSync = new MobileSyncManager(env);
        
        try {
          const syncRequest = await request.json() as MobileSyncRequest;
          const response = await mobileSync.processSyncRequest(syncRequest);

          return new Response(JSON.stringify(response), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : 'Sync failed',
            serverTime: new Date().toISOString()
          }), {
            status: error instanceof Error && error.message.includes('Invalid signature') ? 401 : 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/mobile/changes' && request.method === 'GET') {
        const mobileSync = new MobileSyncManager(env);
        
        try {
          const deviceId = url.searchParams.get('deviceId');
          const since = url.searchParams.get('since') || new Date(0).toISOString();

          if (!deviceId) {
            return new Response(JSON.stringify({
              error: 'deviceId parameter required'
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          const changes = await mobileSync.getChanges(deviceId, since);

          return new Response(JSON.stringify(changes), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: error instanceof Error ? error.message : 'Failed to get changes',
            serverTime: new Date().toISOString()
          }), {
            status: error instanceof Error && error.message.includes('not registered') ? 401 : 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Webhook processing endpoints (for actual webhook events)
      if (path.startsWith('/webhook/') && ['github', 'notion', 'slack', 'generic', 'todoist'].includes(path.split('/')[2])) {
        const webhookDispatcher = new WebhookDispatcher(env);
        const source = path.split('/')[2] as WebhookSource;
        return await webhookDispatcher.processWebhook(source, request);
      }

      if (path === '/inbox' && request.method === 'GET') {
        // Get tasks, excluding already synced ones by default
        const includeAll = url.searchParams.get('include_all') === 'true';
        const tasks = await todoist.getInboxTasks(!includeAll, env.SYNC_METADATA);
        
        // Record metric for inbox fetch
        await metrics.recordMetric({
          timestamp: new Date().toISOString(),
          type: 'inbox_fetch',
          success: true,
          duration: 0, // Will be tracked at higher level if needed
          details: {
            tasksProcessed: tasks.length,
            source: includeAll ? 'all' : 'filtered'
          }
        });
        
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
        
        // Optional flat format for AppleScript importer compatibility
        if (format === 'flat') {
          const flatTasks = enhancedTasks.map(t => ({
            id: t.id,
            title: t.content,
            notes: t.description || '',
            due: t.due?.datetime || t.due?.date || null,
            tags: (t.labels || []).filter(l => l !== 'synced-to-things' && l !== 'synced-from-things')
          }));
          return new Response(JSON.stringify(flatTasks), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        return new Response(JSON.stringify(thingsTasks), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === '/inbox/mark-synced' && request.method === 'POST') {
        // Initialize batch sync manager
        const batchSync = new BatchSyncManager(env);
        
        // Check for idempotency
        const requestId = request.headers.get('X-Request-Id');
        if (requestId) {
          const idempotencyKey = `idempotency:${requestId}`;
          const existing = await env.SYNC_METADATA.get(idempotencyKey);
          if (existing) {
            const record = JSON.parse(existing) as IdempotencyRecord;
            const recordAge = (Date.now() - new Date(record.timestamp).getTime()) / 1000;
            if (recordAge < record.ttl) {
              return new Response(JSON.stringify({
                ...record.result,
                fromCache: true,
                cachedAt: record.timestamp
              }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
          }
        }
        
        // Mark tasks as synced using batch operations
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
              
              // Add to batch (not written yet)
              await batchSync.addMapping(taskMapping);
              
              // Also add label to Todoist task for quick filtering
              try {
                await todoist.updateTaskLabels(task.id, [...task.labels, 'synced-to-things']);
              } catch (e) {
                console.error('Failed to add label:', e);
              }
              
              return { id: task.id, content: task.content, status: 'marked_synced' };
            } catch (error) {
              return { id: task.id, status: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
            }
          })
        );
        
        // Single batch write for all mappings
        await batchSync.flush();
        
        const responseData = { results, count: results.length };
        
        // Store idempotency record if request ID provided
        if (requestId) {
          const idempotencyRecord: IdempotencyRecord = {
            requestId,
            result: responseData,
            timestamp: new Date().toISOString(),
            ttl: 600 // 10 minutes
          };
          
          try {
            await env.SYNC_METADATA.put(
              `idempotency:${requestId}`,
              JSON.stringify(idempotencyRecord),
              { expirationTtl: 600 }
            );
          } catch (error) {
            console.error('Failed to store idempotency record:', error);
          }
        }
        
        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      if (path === '/things/created-mappings' && request.method === 'POST') {
        // Accept created mapping pairs from local importer to finalize IDs on both sides
        // Body: [{ thingsId, todoistId }]
        try {
          const pairs = await request.json() as Array<{ thingsId: string; todoistId: string }>
          if (!Array.isArray(pairs)) {
            return new Response(JSON.stringify({ error: 'Invalid body: expected array' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          const batchSync = new BatchSyncManager(env);
          await batchSync.loadState();

          const results: Array<{ thingsId: string; todoistId: string; updated: boolean } > = [];
          for (const { thingsId, todoistId } of pairs) {
            try {
              const existing = await batchSync.getMappingByTodoistId(todoistId);
              if (!existing) {
                // Attempt to build mapping via current Todoist data
                const todoistTask = await todoist.request<TodoistTask>(`/tasks/${todoistId}`);
                const fingerprint = await createTaskFingerprint(todoistTask.content, todoistTask.description);
                await batchSync.addMapping({
                  todoistId,
                  thingsId,
                  fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: 'exact',
                  version: 2
                });
              } else if (existing.thingsId !== thingsId) {
                // Update thingsId
                await batchSync.addMapping({ ...existing, thingsId });
              }

              // Ensure Todoist back-reference
              try { await todoist.updateTaskWithThingsId(todoistId, thingsId); } catch {}

              results.push({ thingsId, todoistId, updated: true });
            } catch (e) {
              results.push({ thingsId, todoistId, updated: false });
            }
          }

          await batchSync.flush();
          return new Response(JSON.stringify({ updated: results.filter(r => r.updated).length, total: results.length, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Failed to update mappings', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
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
        // Initialize batch sync manager
        const batchSync = new BatchSyncManager(env);
        // Check for idempotency
        const requestId = request.headers.get('X-Request-Id');
        if (requestId) {
          const idempotencyKey = `idempotency:${requestId}`;
          const existing = await env.SYNC_METADATA.get(idempotencyKey);
          if (existing) {
            const record = JSON.parse(existing) as IdempotencyRecord;
            // Check if record is still valid (within TTL)
            const recordAge = (Date.now() - new Date(record.timestamp).getTime()) / 1000;
            if (recordAge < record.ttl) {
              return new Response(JSON.stringify({
                ...record.result,
                fromCache: true,
                cachedAt: record.timestamp
              }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
              });
            }
          }
        }
        
        // Acquire sync lock to prevent concurrent syncs
        const lockToken = await acquireSyncLock(env.SYNC_METADATA);
        if (!lockToken) {
          return new Response(JSON.stringify({
            error: 'Sync already in progress',
            retry_after: 30
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        const startTime = Date.now();
        let syncSuccess = true;
        let syncError: string | undefined;

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
                  // Check for conflicts if we have lastSyncedContent
                  const configManager = new ConfigManager(env.SYNC_METADATA);
                  await configManager.loadConfig();
                  const resolver = new ConflictResolver(configManager.getConfig());
                  
                  // Get the current Todoist task to check for conflicts
                  const todoistTask = await todoist.request<TodoistTask>(`/tasks/${existingMapping.todoistId}`);
                  
                  if (existingMapping.lastSyncedContent) {
                    const conflict = await resolver.detectConflict(
                      todoistTask,
                      task,
                      existingMapping
                    );
                    
                    if (conflict) {
                      // Store conflict for resolution
                      await resolver.storeConflict(conflict, env.SYNC_METADATA);
                      
                      // If auto-resolve is enabled, resolve it
                      if (configManager.getConfig().autoResolveConflicts) {
                        try {
                          const resolution = await resolver.resolveConflict(conflict);
                          
                          // Update Todoist with resolved values
                          await todoist.request(`/tasks/${existingMapping.todoistId}`, {
                            method: 'POST',
                            body: JSON.stringify({
                              content: resolution.resolvedTask.title || resolution.resolvedTask.content,
                              description: resolution.resolvedTask.notes || resolution.resolvedTask.description,
                              due_date: resolution.resolvedTask.due,
                              labels: resolution.resolvedTask.labels
                            })
                          });
                          
                          await resolver.markConflictResolved(conflict.id, env.SYNC_METADATA);
                          
                          return {
                            id: task.id,
                            title: task.title,
                            status: 'conflict_resolved',
                            resolution_strategy: resolution.appliedStrategy,
                            todoist_id: existingMapping.todoistId
                          };
                        } catch (error) {
                          return {
                            id: task.id,
                            title: task.title,
                            status: 'conflict_detected',
                            conflict_id: conflict.id,
                            todoist_id: existingMapping.todoistId
                          };
                        }
                      } else {
                        return {
                          id: task.id,
                          title: task.title,
                          status: 'conflict_detected',
                          conflict_id: conflict.id,
                          todoist_id: existingMapping.todoistId
                        };
                      }
                    }
                  }
                  
                  // No conflict, update mapping with current content
                  const fingerprint = await createTaskFingerprint(task.title, task.notes, task.due);
                  
                  const updatedMapping: TaskMapping = {
                    todoistId: existingMapping.todoistId,
                    thingsId: task.id,
                    fingerprint,
                    lastSynced: new Date().toISOString(),
                    source: existingMapping.source,
                    version: 2,
                    lastSyncedContent: {
                      title: task.title,
                      notes: task.notes,
                      due: task.due,
                      labels: todoistTask.labels
                    },
                    thingsModifiedAt: new Date().toISOString(),
                    todoistModifiedAt: todoistTask.created_at
                  };
                  
                  // Add to batch sync manager (no write yet)
                  await batchSync.addMapping(updatedMapping);
                  
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
                
                // Back-reference: add Things ID to Todoist description for resilience
                try {
                  await todoist.updateTaskWithThingsId(newTask.id, task.id);
                } catch {}
                
                // Create fingerprint for the new task
                const fingerprint = await createTaskFingerprint(task.title, task.notes, task.due);
                
                // Store mapping using new fingerprint method with sync state
                const taskMapping: TaskMapping = {
                  todoistId: newTask.id,
                  thingsId: task.id,
                  fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: 'exact',
                  version: 2,
                  lastSyncedContent: {
                    title: task.title,
                    notes: task.notes,
                    due: task.due,
                    labels: taskLabels
                  },
                  thingsModifiedAt: new Date().toISOString(),
                  todoistModifiedAt: newTask.created_at
                };
                
                // Add to batch sync manager (no write yet)
                await batchSync.addMapping(taskMapping);
                
                // Also add label to mark as synced
                try {
                  await todoist.updateTaskLabels(newTask.id, [...taskLabels, 'synced-from-things']);
                } catch (e) {
                  console.error('Failed to add label:', e);
                }
                
                return { 
                  id: task.id, 
                  title: task.title, 
                  status: 'created',
                  todoist_id: newTask.id 
                };
              } catch (error) {
                // Log the actual error for debugging
                console.error(`Error syncing task "${task.title}":`, error);
                
                // Provide detailed error information
                let errorMessage = 'Unknown error';
                let errorDetails = {};
                
                if (error instanceof Error) {
                  errorMessage = error.message;
                  
                  // Check for common error patterns
                  if (error.message.includes('limit exceeded')) {
                    errorMessage = `Rate limit or quota error: ${error.message}`;
                    errorDetails = { type: 'rate_limit', original: error.message };
                  } else if (error.message.includes('namespace')) {
                    errorMessage = `KV namespace configuration error: ${error.message}`;
                    errorDetails = { type: 'kv_config', original: error.message };
                  } else if (error.message.includes('put()')) {
                    errorMessage = `KV storage write failed: ${error.message}`;
                    errorDetails = { type: 'kv_write', original: error.message };
                  } else if (error.message.includes('401')) {
                    errorMessage = `Todoist authentication failed: ${error.message}`;
                    errorDetails = { type: 'auth', original: error.message };
                  }
                }
                
                return { 
                  id: task.id, 
                  title: task.title,
                  status: 'error', 
                  message: errorMessage,
                  details: errorDetails
                };
              }
            })
          );
          
          // Batch write all mappings at once (single KV write)
          try {
            await batchSync.flush();
          } catch (flushError) {
            console.error('Failed to flush batch sync state:', flushError);
            // Continue anyway - tasks were created in Todoist
          }
          
          const created = results.filter(r => r.status === 'created').length;
          const existing = results.filter(r => r.status === 'already_exists').length;
          const errors = results.filter(r => r.status === 'error').length;
          const conflictsDetected = results.filter(r => r.status === 'conflict_detected').length;
          const conflictsResolved = results.filter(r => r.status === 'conflict_resolved').length;
          
          const responseData = { 
            results, 
            summary: { 
              created, 
              existing, 
              errors, 
              conflictsDetected,
              conflictsResolved,
              total: results.length 
            }
          };
          
          // Record sync metrics
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'things_sync',
            success: errors === 0,
            duration: Date.now() - startTime,
            details: {
              tasksProcessed: results.length,
              created,
              existing,
              errors,
              direction: 'things_to_todoist',
              conflictsDetected,
              conflictsResolved
            }
          });

          // Send outbound webhooks for sync events
          if (created > 0 || conflictsResolved > 0) {
            await sendOutboundWebhook(env, 'task_synced', {
              source: 'things',
              target: 'todoist',
              tasksCreated: created,
              conflictsResolved,
              summary: { created, existing, errors, conflictsDetected, conflictsResolved, total: results.length }
            });
          }

          if (conflictsDetected > 0 && conflictsResolved < conflictsDetected) {
            await sendOutboundWebhook(env, 'conflict_detected', {
              source: 'things',
              target: 'todoist',
              unresolvedConflicts: conflictsDetected - conflictsResolved,
              totalConflicts: conflictsDetected
            });
          }

          if (errors === 0) {
            await sendOutboundWebhook(env, 'sync_completed', {
              source: 'things',
              target: 'todoist',
              metrics: { created, existing, errors, conflictsDetected, conflictsResolved, total: results.length }
            });
          } else {
            await sendOutboundWebhook(env, 'sync_failed', {
              source: 'things',
              target: 'todoist',
              errors,
              metrics: { created, existing, errors, conflictsDetected, conflictsResolved, total: results.length }
            });
          }

          // Store idempotency record if request ID provided
          if (requestId) {
            const idempotencyRecord: IdempotencyRecord = {
              requestId,
              result: responseData,
              timestamp: new Date().toISOString(),
              ttl: 600 // 10 minutes
            };
            
            try {
              await env.SYNC_METADATA.put(
                `idempotency:${requestId}`,
                JSON.stringify(idempotencyRecord),
                { expirationTtl: 600 }
              );
            } catch (error) {
              // Don't fail the request if idempotency storage fails
              console.error('Failed to store idempotency record:', error);
            }
          }
          
          return new Response(JSON.stringify(responseData), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          syncSuccess = false;
          syncError = error instanceof Error ? error.message : 'Unknown error';
          
          // Record failure metric
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'things_sync',
            success: false,
            duration: Date.now() - startTime,
            details: {
              direction: 'things_to_todoist'
            },
            errorMessage: syncError
          });

          throw error;
        } finally {
          if (lockToken) {
            await releaseSyncLock(env.SYNC_METADATA, lockToken);
          }
        }
      }

      if (path === '/things/sync-completed' && request.method === 'POST') {
        const startTime = Date.now();
        
        try {
          // Receive completed tasks from Things
          const completedTasks = await request.json() as CompletedTask[];
          
          const results = await Promise.all(
            completedTasks.map(async (task) => {
              try {
                // Prefer batch mapping by Things ID
                const batchSync = new BatchSyncManager(env);
                const mapping = await batchSync.getMappingByThingsId(task.thingsId);
                if (!mapping) {
                  // Fallbacks: legacy KV and description scan
                  let legacy = await env.SYNC_METADATA.get(`mapping:things:${task.thingsId}`);
                  if (!legacy) {
                    try {
                      const allTasks = await todoist.getInboxTasks(false, env.SYNC_METADATA);
                      const match = allTasks.find(t => t.description && t.description.includes(`[things-id:${task.thingsId}]`));
                      if (match) {
                        // Reduce KV writes: skip storing legacy mapping; just close the task
                        legacy = JSON.stringify({ todoistId: match.id, thingsId: task.thingsId, lastSynced: new Date().toISOString() } as SyncMetadata);
                      }
                    } catch (findError) {
                      console.error('Error finding task by Things ID:', findError);
                    }
                  }
                  if (!legacy) {
                    return { thingsId: task.thingsId, status: 'not_found', message: 'No Todoist mapping found' };
                  }
                  const legacyData = JSON.parse(legacy) as SyncMetadata;
                  const okLegacy = await todoist.closeTask(legacyData.todoistId);
                  return okLegacy
                    ? { thingsId: task.thingsId, todoistId: legacyData.todoistId, status: 'completed', completedAt: task.completedAt }
                    : { thingsId: task.thingsId, todoistId: legacyData.todoistId, status: 'error', message: 'Failed to close task in Todoist' };
                }

                const ok = await todoist.closeTask(mapping.todoistId);
                if (ok) {
                  // Reduce KV writes: avoid per-item flush; optional mapping update skipped
                  return { thingsId: task.thingsId, todoistId: mapping.todoistId, status: 'completed', completedAt: task.completedAt };
                }
                return { thingsId: task.thingsId, todoistId: mapping.todoistId, status: 'error', message: 'Failed to close task in Todoist' };
              } catch (error) {
                return { thingsId: task.thingsId, status: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
              }
            })
          );
          
          const completed = results.filter(r => r.status === 'completed').length;
          const notFound = results.filter(r => r.status === 'not_found').length;
          const errors = results.filter(r => r.status === 'error').length;
          
          // Record metrics for completed sync
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'completed_sync',
            success: errors === 0,
            duration: Date.now() - startTime,
            details: {
              tasksProcessed: results.length,
              completed,
              errors,
              source: 'things_completed'
            }
          });
          
          return new Response(JSON.stringify({
            results,
            summary: { completed, notFound, errors, total: results.length }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          console.error('Error syncing completed tasks:', error);
          
          // Record failure metric
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'completed_sync',
            success: false,
            duration: Date.now() - startTime,
            details: {
              source: 'things_completed'
            },
            errorMessage: error instanceof Error ? error.message : 'Unknown error'
          });
          
          return new Response(JSON.stringify({
            error: 'Failed to sync completed tasks',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/things/sync-deleted' && request.method === 'POST') {
        try {
          const deleted = await request.json() as Array<{ thingsId: string; deletedAt?: string }>;
          if (!Array.isArray(deleted)) {
            return new Response(JSON.stringify({ error: 'Invalid body: expected array' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          const batchSync = new BatchSyncManager(env);
          await batchSync.loadState();

          const results = await Promise.all(deleted.map(async (d) => {
            try {
              const mapping = await batchSync.getMappingByThingsId(d.thingsId);
              if (!mapping) {
                return { thingsId: d.thingsId, status: 'not_found' };
              }
              // Prefer to close Todoist task (non-destructive). If already completed, this is idempotent.
              const ok = await todoist.closeTask(mapping.todoistId);
              if (ok) {
                await batchSync.addMapping({ ...mapping, lastSynced: new Date().toISOString() });
                return { thingsId: d.thingsId, todoistId: mapping.todoistId, status: 'closed' };
              }
              return { thingsId: d.thingsId, todoistId: mapping.todoistId, status: 'error' };
            } catch (e) {
              return { thingsId: d.thingsId, status: 'error' };
            }
          }));

          await batchSync.flush();
          const closed = results.filter(r => r.status === 'closed').length;
          const notFound = results.filter(r => r.status === 'not_found').length;
          const errors = results.filter(r => r.status === 'error').length;
          return new Response(JSON.stringify({ results, summary: { closed, notFound, errors, total: results.length } }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Failed to sync deletions', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      // Repair utility: backfill batch mappings from Todoist descriptions containing [things-id:...] (no task creation)
      if (path === '/repair/backfill-mappings' && request.method === 'POST') {
        // Require repair auth token
        const authToken = request.headers.get('X-Repair-Auth');
        if (!authToken || authToken !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized - valid X-Repair-Auth header required' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const dryRun = url.searchParams.get('dry_run') === 'true';
        try {
          const batchSync = new BatchSyncManager(env);
          await batchSync.loadState();

          const tasks = await todoist.getInboxTasks(false, env.SYNC_METADATA);
          const results: Array<{ todoistId: string; thingsId?: string; action: string } > = [];
          let created = 0, updated = 0, skipped = 0, missing = 0;

          for (const task of tasks) {
            const thingsId = extractThingsIdFromNotes(task.description || '');
            if (!thingsId) {
              missing++;
              continue;
            }
            const fingerprint = await createTaskFingerprint(task.content, task.description);
            const existing = await batchSync.getMapping(fingerprint.primaryHash);
            if (existing) {
              if (existing.thingsId !== thingsId) {
                if (!dryRun) {
                  await batchSync.addMapping({ ...existing, thingsId, lastSynced: new Date().toISOString() });
                }
                updated++;
                results.push({ todoistId: task.id, thingsId, action: 'updated' });
              } else {
                skipped++;
                results.push({ todoistId: task.id, thingsId, action: 'skipped' });
              }
            } else {
              const mapping: TaskMapping = {
                todoistId: task.id,
                thingsId,
                fingerprint,
                lastSynced: new Date().toISOString(),
                source: 'backfill',
                version: 2
              };
              if (!dryRun) {
                await batchSync.addMapping(mapping);
              }
              created++;
              results.push({ todoistId: task.id, thingsId, action: 'created' });
            }
          }

          if (!dryRun) {
            await batchSync.flush();
          }

          return new Response(JSON.stringify({
            dryRun,
            summary: { created, updated, skipped, missing, total: tasks.length },
            results
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Backfill failed', message: error instanceof Error ? error.message : 'Unknown error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Repair utility: backfill batch mappings by fingerprint matching Things → Todoist
      if (path === '/repair/backfill-by-fingerprint' && request.method === 'POST') {
        // Require repair auth token
        const authToken = request.headers.get('X-Repair-Auth');
        if (!authToken || authToken !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized - valid X-Repair-Auth header required' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        try {
          const thingsTasks = await request.json() as ThingsInboxTask[];
          if (!Array.isArray(thingsTasks)) {
            return new Response(JSON.stringify({ error: 'Invalid body: expected array of Things tasks' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }

          const batchSync = new BatchSyncManager(env);
          await batchSync.loadState();

          let created = 0, updated = 0, notFound = 0, skipped = 0;
          const results: any[] = [];

          for (const t of thingsTasks) {
            try {
              // Try to find existing Todoist task via fingerprint
              const match = await todoist.findExistingTaskByFingerprint(t.title, t.notes, t.due, t.id, env.SYNC_METADATA);
              if (!match) {
                notFound++;
                results.push({ thingsId: t.id, action: 'not_found' });
                continue;
              }

              const existing = await batchSync.getMapping(match.fingerprint.primaryHash);
              if (existing) {
                if (existing.thingsId !== t.id || existing.todoistId !== match.todoistId) {
                  await batchSync.addMapping({ ...existing, thingsId: t.id, todoistId: match.todoistId, lastSynced: new Date().toISOString() });
                  updated++;
                  results.push({ thingsId: t.id, todoistId: match.todoistId, action: 'updated' });
                } else {
                  skipped++;
                  results.push({ thingsId: t.id, todoistId: match.todoistId, action: 'skipped' });
                }
              } else {
                await batchSync.addMapping({
                  todoistId: match.todoistId,
                  thingsId: t.id,
                  fingerprint: match.fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: match.source || 'hash',
                  version: 2
                });
                created++;
                results.push({ thingsId: t.id, todoistId: match.todoistId, action: 'created' });
              }
            } catch (e) {
              results.push({ thingsId: t.id, action: 'error', message: e instanceof Error ? e.message : 'Unknown error' });
            }
          }

          await batchSync.flush();
          return new Response(JSON.stringify({ summary: { created, updated, skipped, notFound, total: thingsTasks.length }, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Backfill (fingerprint) failed', message: error instanceof Error ? error.message : 'Unknown error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/repair/close-todoist' && request.method === 'POST') {
        // Close specific Todoist tasks (authoritative clean-up). Requires repair auth.
        const authToken = request.headers.get('X-Repair-Auth');
        if (!authToken || authToken !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized - valid X-Repair-Auth header required' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        try {
          const body = await request.json() as { ids: string[] };
          if (!body || !Array.isArray(body.ids)) {
            return new Response(JSON.stringify({ error: 'Invalid body: expected { ids: string[] }' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          const results = await Promise.all(body.ids.map(async (id) => ({ id, closed: await todoist.closeTask(id) })));
          const closed = results.filter(r => r.closed).length;
          return new Response(JSON.stringify({ closed, total: results.length, results }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Failed to close tasks', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/repair/delete-mappings' && request.method === 'POST') {
        // Delete batch mappings by fingerprint hash (array of strings)
        const authToken = request.headers.get('X-Repair-Auth');
        if (!authToken || authToken !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized - valid X-Repair-Auth header required' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        try {
          const body = await request.json() as { hashes: string[] } | string[];
          const hashes = Array.isArray(body) ? body as string[] : (body as any)?.hashes;
          if (!Array.isArray(hashes)) {
            return new Response(JSON.stringify({ error: 'Invalid body: expected { hashes: string[] } or [hashes]' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          const batchSync = new BatchSyncManager(env);
          await batchSync.loadState();
          let deleted = 0;
          for (const h of hashes) {
            try {
              await batchSync.removeMapping(h);
              deleted++;
            } catch {}
          }
          await batchSync.flush();
          return new Response(JSON.stringify({ deleted, total: hashes.length }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Failed to delete mappings', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/sync/status' && request.method === 'GET') {
        const lockKey = 'sync:lock';
        const lockData = await env.SYNC_METADATA.get(lockKey);
        const isLocked = lockData ? JSON.parse(lockData).timestamp > Date.now() - 30000 : false;
        
        // Get stats from batch state instead of listing all keys
        const batchState = await env.SYNC_METADATA.get('sync-state:batch');
        let thingsMappings = 0;
        let todoistMappings = 0;
        let hashCount = 0;
        
        if (batchState) {
          const state = JSON.parse(batchState);
          hashCount = Object.keys(state.mappings || {}).length;
          thingsMappings = hashCount; // All are synced
          todoistMappings = hashCount; // All are synced
        }
        
        // Analyze migration status from batch state
        let migratedMappings = hashCount;
        let pendingMigration = 0;
        
        // No need to iterate through individual keys anymore
        // All mappings in batch state are considered migrated

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
              total: thingsMappings + todoistMappings
            },
            taggedTasks: {
              total: taggedTasks.length,
              withFingerprints: taggedTasksWithFingerprints,
              pendingMigration: taggedTasks.length - taggedTasksWithFingerprints
            }
          },
          fingerprint: {
            hashMappings: hashCount,
            migratedLegacyMappings: migratedMappings,
            pendingLegacyMigration: pendingMigration
          },
          migration: {
            progress: '100%', // All batch state mappings are migrated
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

      // Repair: unmark current Todoist inbox tasks as synced (removes fingerprint mappings)
      if (path === '/inbox/unmark-all' && request.method === 'POST') {
        // Require auth header for dangerous operations
        const authHeader = request.headers.get('X-Repair-Auth');
        if (authHeader !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized', message: 'Missing or invalid X-Repair-Auth header' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        // Check for dry-run mode
        const isDryRun = url.searchParams.get('dry_run') === 'true';
        
        try {
          const tasks = await todoist.getInboxTasks(false, env.SYNC_METADATA); // include all
          const results = [] as Array<{ id: string; removed: boolean; hash?: string; title?: string }>;
          
          for (const task of tasks) {
            try {
              const fingerprint = await createTaskFingerprint(task.content, task.description);
              
              if (isDryRun) {
                // In dry-run, just check if mapping exists
                const mapping = await env.SYNC_METADATA.get(`hash:${fingerprint.primaryHash}`);
                results.push({ 
                  id: task.id, 
                  removed: false, 
                  hash: fingerprint.primaryHash,
                  title: task.content,
                  wouldRemove: !!mapping
                });
              } else {
                // Actually delete the mapping
                await env.SYNC_METADATA.delete(`hash:${fingerprint.primaryHash}`);
                results.push({ 
                  id: task.id, 
                  removed: true, 
                  hash: fingerprint.primaryHash,
                  title: task.content 
                });
              }
            } catch {
              results.push({ id: task.id, removed: false });
            }
          }
          
          return new Response(JSON.stringify({ 
            count: results.length, 
            results,
            mode: isDryRun ? 'dry_run' : 'executed'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Failed to unmark', message: error instanceof Error ? error.message : 'Unknown error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      // Per-task unmark endpoint
      if (path.startsWith('/inbox/unmark/') && request.method === 'POST') {
        const taskId = path.split('/')[3];
        
        // Require auth header
        const authHeader = request.headers.get('X-Repair-Auth');
        if (authHeader !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        try {
          const task = await todoist.request<TodoistTask>(`/tasks/${taskId}`);
          const fingerprint = await createTaskFingerprint(task.content, task.description);
          await env.SYNC_METADATA.delete(`hash:${fingerprint.primaryHash}`);
          
          return new Response(JSON.stringify({ 
            id: taskId,
            removed: true,
            hash: fingerprint.primaryHash 
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({ 
            error: 'Failed to unmark task',
            message: error instanceof Error ? error.message : 'Unknown error' 
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Debug endpoint: read single KV mapping
      if (path.startsWith('/debug/kv/') && request.method === 'GET') {
        const key = decodeURIComponent(path.substring(10));
        
        try {
          const value = await env.SYNC_METADATA.get(key);
          if (!value) {
            return new Response(JSON.stringify({ key, value: null, exists: false }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          try {
            const parsed = JSON.parse(value);
            return new Response(JSON.stringify({ key, value: parsed, exists: true }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          } catch {
            return new Response(JSON.stringify({ key, value, exists: true }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
        } catch (error) {
          return new Response(JSON.stringify({ 
            error: 'Failed to read KV',
            message: error instanceof Error ? error.message : 'Unknown error' 
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }
      
      // Debug endpoint: preview hash computation
      if (path === '/debug/hash' && request.method === 'GET') {
        const title = url.searchParams.get('title') || '';
        const notes = url.searchParams.get('notes') || '';
        const due = url.searchParams.get('due') || '';
        
        try {
          const fingerprint = await createTaskFingerprint(title, notes, due);
          const hashMapping = await env.SYNC_METADATA.get(`hash:${fingerprint.primaryHash}`);
          
          return new Response(JSON.stringify({
            input: { title, notes, due },
            fingerprint,
            hashKey: `hash:${fingerprint.primaryHash}`,
            existingMapping: hashMapping ? JSON.parse(hashMapping) : null
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({ 
            error: 'Failed to compute hash',
            message: error instanceof Error ? error.message : 'Unknown error' 
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/debug/mappings' && request.method === 'GET') {
        // Debug endpoint to analyze fingerprint mappings and detect issues (batch-aware)
        try {
          const results = {
            mappings: [],
            legacyMappings: [],
            todoistTasks: [],
            analysis: {
              duplicateFingerprints: [],
              orphanedMappings: [],
              tasksWithoutMappings: []
            }
          } as any;

          // Load batch state once
          const batchSync = new BatchSyncManager(env);
          const state = await batchSync.loadState();
          results.mappings = Object.values(state.mappings);

          // Legacy mappings are no longer supported - all in batch state
          // Set to empty array for backward compatibility
          results.legacyMappings = [];

          // Get all current Todoist tasks
          const allTasks = await todoist.getInboxTasks(false, env.SYNC_METADATA);
          for (const task of allTasks) {
            const fingerprint = await createTaskFingerprint(task.content, task.description);
            results.todoistTasks.push({
              id: task.id,
              title: task.content,
              description: task.description || '',
              labels: task.labels,
              fingerprint: fingerprint.primaryHash,
              hasMapping: !!state.mappings[fingerprint.primaryHash]
            });
          }

          // Analysis: Find tasks without mappings
          results.analysis.tasksWithoutMappings = results.todoistTasks.filter((t: any) => !t.hasMapping);

          // Analysis: Find orphaned mappings (mappings without corresponding tasks)
          results.analysis.orphanedMappings = Object.values(state.mappings).filter((m: any) => 
            !results.todoistTasks.some((t: any) => t.id === m.todoistId)
          );

          // Analysis: Find duplicate fingerprints
          const fingerprintCounts: Record<string, number> = {};
          Object.values(state.mappings).forEach((m: any) => {
            fingerprintCounts[m.fingerprint.primaryHash] = (fingerprintCounts[m.fingerprint.primaryHash] || 0) + 1;
          });
          results.analysis.duplicateFingerprints = Object.entries(fingerprintCounts)
            .filter(([_, count]) => (count as number) > 1)
            .map(([hash, count]) => ({ hash, count }));

          return new Response(JSON.stringify(results, null, 2), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Debug analysis failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Migration endpoints
      if (path === '/kv/migration/verify' && request.method === 'GET') {
        try {
          const manager = new KVMigrationManager(env);
          const result = await manager.verifyMigration();
          return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Verification failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/kv/migration/estimate' && request.method === 'GET') {
        try {
          const manager = new KVMigrationManager(env);
          const estimate = await manager.estimateReduction();
          return new Response(JSON.stringify(estimate), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Estimation failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/kv/migration/run' && request.method === 'POST') {
        try {
          const manager = new KVMigrationManager(env);
          // Safe run: keep originals for a rollback window
          const result = await manager.runFullMigration();
          return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Migration failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/kv/migration/cleanup' && request.method === 'POST') {
        try {
          const aggressive = url.searchParams.get('aggressive') === 'true';
          const manager = new KVMigrationManager(env);
          const result = await (manager as any).cleanupLegacyMappings(aggressive);
          return new Response(JSON.stringify(result), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Cleanup failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      // Page-wise migration endpoints to avoid subrequest limits
      if (path === '/kv/migration/metrics-page' && request.method === 'POST') {
        try {
          const keepOriginals = url.searchParams.get('keepOriginals') !== 'false';
          const limit = parseInt(url.searchParams.get('limit') || '200', 10);
          const cursor = url.searchParams.get('cursor') || undefined;
          const aggregatorModule = await import('./metrics-aggregator');
          const aggregator = new aggregatorModule.MetricsAggregator(env);
          const page = await aggregator.migrateExistingMetricsPage({ keepOriginals, limit, cursor });
          return new Response(JSON.stringify(page), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Metrics page migration failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/kv/migration/webhooks-page' && request.method === 'POST') {
        try {
          const limit = parseInt(url.searchParams.get('limit') || '200', 10);
          const cursor = url.searchParams.get('cursor') || undefined;
          const { WebhookBatchManager } = await import('./webhook-batch-manager');
          const wb = new WebhookBatchManager(env);
          const page = await wb.migrateExistingDeliveries({ limit, cursor });
          return new Response(JSON.stringify(page), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Webhook page migration failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      if (path === '/kv/migration/cleanup-page' && request.method === 'POST') {
        try {
          const prefix = url.searchParams.get('prefix');
          const limit = parseInt(url.searchParams.get('limit') || '200', 10);
          const cursor = url.searchParams.get('cursor') || undefined;
          const allowed = new Set(['mobile-mapping:', 'webhook-delivery:', 'mapping:', 'hash:', 'sync-request:', 'sync-response:']);
          if (!prefix || !allowed.has(prefix)) {
            return new Response(JSON.stringify({ error: 'Invalid or missing prefix', allowed: Array.from(allowed) }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          const page = await env.SYNC_METADATA.list({ prefix, limit, cursor } as any);
          let deleted = 0;
          for (const key of page.keys) {
            await env.SYNC_METADATA.delete(key.name);
            deleted++;
          }
          return new Response(JSON.stringify({ deleted, nextCursor: (page as any).cursor, listComplete: Boolean((page as any).list_complete) }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (error) {
          return new Response(JSON.stringify({ error: 'Cleanup page failed', message: error instanceof Error ? error.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }

      // Consistency check endpoint
      if (path === '/sync/verify' && request.method === 'GET') {
        try {
          const discrepancies = [];
          const recommendations = [];
          
          // Get all Todoist tasks
          const todoistTasks = await todoist.getInboxTasks(false, env.SYNC_METADATA);
          
          // Load batch mappings (new architecture)
          const batchSync = new BatchSyncManager(env);
          const state = await batchSync.loadState();
          const hashMappings = new Map<string, TaskMapping>();
          Object.values(state.mappings).forEach((m) => {
            hashMappings.set(`hash:${m.fingerprint.primaryHash}`, m);
          });
          
          // Check for orphaned mappings (mappings without corresponding Todoist tasks)
          for (const [hashKey, mapping] of hashMappings) {
            const taskExists = todoistTasks.some(t => t.id === mapping.todoistId);
            if (!taskExists) {
              discrepancies.push({
                type: 'orphaned_mapping',
                hashKey,
                todoistId: mapping.todoistId,
                thingsId: mapping.thingsId
              });
              recommendations.push(`Remove orphaned mapping: DELETE ${hashKey}`);
            }
          }
          
          // Check for Todoist tasks without proper mappings
          for (const task of todoistTasks) {
            const fingerprint = await createTaskFingerprint(task.content, task.description);
            const hashKey = `hash:${fingerprint.primaryHash}`;
            const mapping = hashMappings.get(hashKey);
            
            if (!mapping) {
              // Check if task has Things ID in description
              const thingsId = extractThingsIdFromNotes(task.description || '');
              if (thingsId) {
                discrepancies.push({
                  type: 'missing_hash_mapping',
                  todoistId: task.id,
                  title: task.content,
                  thingsId,
                  hashKey
                });
                recommendations.push(`Create mapping for task "${task.content}"`);
              }
            } else {
              // Check if Things ID in description matches mapping
              const thingsIdInNotes = extractThingsIdFromNotes(task.description || '');
              if (thingsIdInNotes && thingsIdInNotes !== mapping.thingsId) {
                discrepancies.push({
                  type: 'mismatched_things_id',
                  todoistId: task.id,
                  title: task.content,
                  thingsIdInNotes,
                  thingsIdInMapping: mapping.thingsId
                });
                recommendations.push(`Fix Things ID mismatch for "${task.content}"`);
              }
            }
            
            // Check for duplicate sync tags
            const hasSyncTags = task.labels.some(l => 
              l === 'synced-to-things' || l === 'synced-from-things'
            );
            if (hasSyncTags && mapping) {
              discrepancies.push({
                type: 'unnecessary_sync_tags',
                todoistId: task.id,
                title: task.content,
                labels: task.labels
              });
              recommendations.push(`Remove sync tags from "${task.content}" (already tracked by fingerprint)`);
            }
          }
          
          // Summary
          const summary = {
            todoistTaskCount: todoistTasks.length,
            hashMappingCount: hashMappings.size,
            discrepancyCount: discrepancies.length,
            isHealthy: discrepancies.length === 0
          };
          
          return new Response(JSON.stringify({
            summary,
            discrepancies,
            recommendations,
            timestamp: new Date().toISOString()
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Verification failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/sync/bulk' && request.method === 'POST') {
        // Bulk sync endpoint for force re-sync
        // Requires auth for safety
        const authHeader = request.headers.get('X-Repair-Auth');
        if (authHeader !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const dryRun = url.searchParams.get('dry_run') === 'true';
        const direction = url.searchParams.get('direction') || 'both'; // both, todoist_to_things, things_to_todoist
        const startTime = Date.now();
        
        const results = {
          todoistTasks: 0,
          mappingsCleared: 0,
          mappingsCreated: 0,
          errors: [],
          dryRun,
          direction,
          actions: []
        };

        try {
          if (direction === 'both' || direction === 'clear_mappings') {
            // Step 1: Clear all existing mappings for a fresh start
            // Use batch state instead of listing individual keys
            const batchSync = new BatchSyncManager(env);
            const state = await batchSync.loadState();
            const mappingCount = Object.keys(state.mappings).length;
            
            if (!dryRun) {
              // Clear the entire batch state
              await env.SYNC_METADATA.delete('sync-state:batch');
              // Reinitialize with empty state
              await batchSync.flush();
            }
            
            results.mappingsCleared = mappingCount;
            results.actions.push(`Cleared ${mappingCount} mappings from batch state`);
          }

          if (direction === 'both' || direction === 'todoist_to_things') {
            // Step 2: Force re-sync all Todoist tasks
            const allTasks = await todoist.getInboxTasks(false); // Get all tasks
            results.todoistTasks = allTasks.length;

            // Create fresh mappings for all tasks
            for (const task of allTasks) {
              try {
                const fingerprint = await createTaskFingerprint(task.content, task.description);
                const taskMapping: TaskMapping = {
                  todoistId: task.id,
                  thingsId: `bulk-sync-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                  fingerprint,
                  lastSynced: new Date().toISOString(),
                  source: 'exact',
                  version: 2
                };

                if (!dryRun) {
                  // Retry logic for KV operations
                  let retries = 3;
                  let lastError;
                  
                  while (retries > 0) {
                    try {
                      await env.SYNC_METADATA.put(
                        `hash:${fingerprint.primaryHash}`,
                        JSON.stringify(taskMapping)
                      );
                      break; // Success, exit retry loop
                    } catch (kvError) {
                      lastError = kvError;
                      retries--;
                      if (retries > 0) {
                        // Exponential backoff: 100ms, 200ms, 400ms
                        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, 3 - retries)));
                      }
                    }
                  }
                  
                  if (retries === 0 && lastError) {
                    throw lastError; // Throw the actual error after all retries failed
                  }
                }
                
                results.mappingsCreated++;
                results.actions.push(`Create mapping for: ${task.content.substring(0, 50)}...`);
              } catch (error) {
                // Provide more detailed error information
                let errorMessage = 'Unknown error';
                if (error instanceof Error) {
                  errorMessage = error.message;
                  // Check for specific KV errors
                  if (error.message.includes('limit')) {
                    errorMessage = `KV operation failed: ${error.message}`;
                  } else if (error.message.includes('namespace')) {
                    errorMessage = `KV namespace error: ${error.message}`;
                  }
                }
                
                results.errors.push({
                  taskId: task.id,
                  content: task.content.substring(0, 50),
                  error: errorMessage,
                  details: error instanceof Error ? error.stack : undefined
                });
              }
            }
          }

          if (direction === 'things_to_todoist') {
            // This would require AppleScript integration which we can't do from the worker
            results.actions.push('Things to Todoist sync must be initiated from the client script');
          }

          // Record bulk sync metrics
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'bulk_sync',
            success: results.errors.length === 0,
            duration: Date.now() - startTime,
            details: {
              tasksProcessed: results.todoistTasks,
              created: results.mappingsCreated,
              errors: results.errors.length,
              direction,
              source: dryRun ? 'dry_run' : 'executed'
            }
          });

          return new Response(JSON.stringify({
            ...results,
            summary: `Processed ${results.todoistTasks} tasks, cleared ${results.mappingsCleared} mappings, created ${results.mappingsCreated} new mappings`,
            timestamp: new Date().toISOString()
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          // Record failure metric
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'bulk_sync',
            success: false,
            duration: Date.now() - startTime,
            details: {
              direction,
              source: dryRun ? 'dry_run' : 'executed'
            },
            errorMessage: error instanceof Error ? error.message : 'Unknown error'
          });

          return new Response(JSON.stringify({
            error: 'Bulk sync failed',
            message: error instanceof Error ? error.message : 'Unknown error',
            results
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/metrics' && request.method === 'GET') {
        try {
          const hours = parseInt(url.searchParams.get('hours') || '24');
          const summary = await metrics.getMetricsSummary(hours);
          
          return new Response(JSON.stringify(summary), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get metrics',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/metrics/cleanup' && request.method === 'POST') {
        // Require auth header for maintenance operations
        const authHeader = request.headers.get('X-Repair-Auth');
        if (authHeader !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        try {
          const deleted = await metrics.cleanupOldMetrics();
          return new Response(JSON.stringify({
            deleted,
            message: `Cleaned up ${deleted} old metrics`
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to cleanup metrics',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Conflict resolution endpoints
      if (path === '/conflicts' && request.method === 'GET') {
        try {
          const configManager = new ConfigManager(env.SYNC_METADATA);
          await configManager.loadConfig();
          const resolver = new ConflictResolver(configManager.getConfig());
          
          const conflicts = await resolver.getUnresolvedConflicts(env.SYNC_METADATA);
          
          return new Response(JSON.stringify({
            conflicts,
            count: conflicts.length,
            timestamp: new Date().toISOString()
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get conflicts',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/conflicts/resolve' && request.method === 'POST') {
        try {
          const body = await request.json() as {
            conflictId: string;
            strategy?: ConflictResolutionStrategy;
          };
          
          const configManager = new ConfigManager(env.SYNC_METADATA);
          await configManager.loadConfig();
          const resolver = new ConflictResolver(configManager.getConfig());
          
          // Get the conflict
          const conflicts = await resolver.getUnresolvedConflicts(env.SYNC_METADATA);
          const conflict = conflicts.find(c => c.id === body.conflictId);
          
          if (!conflict) {
            return new Response(JSON.stringify({
              error: 'Conflict not found',
              conflictId: body.conflictId
            }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // Resolve the conflict
          const resolution = await resolver.resolveConflict(conflict, body.strategy);
          
          // Mark as resolved
          await resolver.markConflictResolved(conflict.id, env.SYNC_METADATA);
          
          // Record metric
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'things_sync',
            success: true,
            duration: 0,
            details: {
              source: 'conflict_resolution',
              direction: resolution.appliedStrategy
            }
          });
          
          return new Response(JSON.stringify({
            resolved: true,
            resolution: resolution.resolvedTask,
            strategy: resolution.appliedStrategy,
            timestamp: new Date().toISOString()
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to resolve conflict',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Configuration endpoints
      if (path === '/config' && request.method === 'GET') {
        try {
          const configManager = new ConfigManager(env.SYNC_METADATA);
          const config = await configManager.loadConfig();
          
          return new Response(JSON.stringify(config), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get configuration',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/config' && request.method === 'PUT') {
        try {
          const body = await request.json() as Partial<SyncConfig>;
          const configManager = new ConfigManager(env.SYNC_METADATA);
          
          // Validate configuration
          const validation = configManager.validateConfig(body);
          if (!validation.valid) {
            return new Response(JSON.stringify({
              error: 'Invalid configuration',
              errors: validation.errors
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          const config = await configManager.saveConfig(body);
          
          return new Response(JSON.stringify({
            config,
            message: 'Configuration updated successfully'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to update configuration',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Webhook configuration endpoints
      if (path === '/webhook/config' && request.method === 'GET') {
        try {
          const config = await env.SYNC_METADATA.get('webhook-config');
          return new Response(config || '{}', {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get webhook configuration',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/webhook/config' && request.method === 'PUT') {
        try {
          const config = await request.json();
          
          // Basic validation
          if (typeof config !== 'object' || !config.sources) {
            return new Response(JSON.stringify({
              error: 'Invalid webhook configuration'
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          await env.SYNC_METADATA.put('webhook-config', JSON.stringify(config));
          
          return new Response(JSON.stringify({
            success: true,
            message: 'Webhook configuration updated'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to update webhook configuration',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/webhook/test' && request.method === 'POST') {
        try {
          const body = await request.json();
          const { source, payload } = body;
          
          if (!source || !payload) {
            return new Response(JSON.stringify({
              error: 'Missing source or payload'
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // Create test webhook request
          const testRequest = new Request(request.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Test-Webhook': 'true'
            },
            body: JSON.stringify(payload)
          });

          const webhookDispatcher = new WebhookDispatcher(env);
          const result = await webhookDispatcher.processWebhook(source as WebhookSource, testRequest);
          
          return new Response(JSON.stringify({
            testResult: await result.json(),
            status: result.status
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Webhook test failed',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Outbound webhook management endpoints
      if (path === '/webhook/subscribers' && request.method === 'GET') {
        try {
          const subscribers = await env.SYNC_METADATA.get('outbound-webhooks');
          return new Response(subscribers || '[]', {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get webhook subscribers',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/webhook/subscribers' && request.method === 'POST') {
        try {
          const subscriber = await request.json();
          
          // Validate subscriber
          if (!subscriber.url || !Array.isArray(subscriber.events)) {
            return new Response(JSON.stringify({
              error: 'Invalid subscriber: url and events array required'
            }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          // Get existing subscribers
          const existingData = await env.SYNC_METADATA.get('outbound-webhooks');
          const subscribers = existingData ? JSON.parse(existingData) : [];

          // Add new subscriber
          const newSubscriber = {
            id: `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            url: subscriber.url,
            secret: subscriber.secret || null,
            events: subscriber.events,
            enabled: subscriber.enabled !== false,
            createdAt: new Date().toISOString(),
            retryPolicy: subscriber.retryPolicy || {
              enabled: true,
              maxRetries: 3,
              backoffMs: 1000
            }
          };

          subscribers.push(newSubscriber);
          await env.SYNC_METADATA.put('outbound-webhooks', JSON.stringify(subscribers));

          return new Response(JSON.stringify({
            success: true,
            subscriber: newSubscriber
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to add webhook subscriber',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path.startsWith('/webhook/subscribers/') && request.method === 'DELETE') {
        try {
          const subscriberId = path.split('/')[3];
          
          const existingData = await env.SYNC_METADATA.get('outbound-webhooks');
          const subscribers = existingData ? JSON.parse(existingData) : [];
          
          const updatedSubscribers = subscribers.filter((s: any) => s.id !== subscriberId);
          
          if (subscribers.length === updatedSubscribers.length) {
            return new Response(JSON.stringify({
              error: 'Subscriber not found'
            }), {
              status: 404,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }

          await env.SYNC_METADATA.put('outbound-webhooks', JSON.stringify(updatedSubscribers));

          return new Response(JSON.stringify({
            success: true,
            message: 'Subscriber deleted'
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to delete webhook subscriber',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/webhook/deliveries' && request.method === 'GET') {
        try {
          const hours = parseInt(url.searchParams.get('hours') || '24');
          
          // Use WebhookBatchManager for efficient retrieval
          const { WebhookBatchManager } = await import('./webhook-batch-manager');
          const webhookBatch = new WebhookBatchManager(env);
          const results = await webhookBatch.getDeliveries(hours);

          return new Response(JSON.stringify({
            deliveries: results,
            count: results.length,
            timeRangeHours: hours
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get webhook deliveries',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      // Sync coordination endpoints for CF Workers ↔ Local Script communication
      if (path === '/sync/requests' && request.method === 'GET') {
        try {
          const syncRequests = await env.SYNC_METADATA.list({ prefix: 'sync-request:' });
          const requests = [];
          
          for (const key of syncRequests.keys) {
            const request = await env.SYNC_METADATA.get(key.name);
            if (request) {
              requests.push(JSON.parse(request));
            }
          }
          
          return new Response(JSON.stringify({
            requests: requests.filter(r => r.status === 'pending'),
            count: requests.length,
            timestamp: new Date().toISOString()
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to get sync requests',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/sync/respond' && request.method === 'POST') {
        try {
          const body = await request.json() as {
            requestId?: string;
            type: string;
            status: string;
            tasksProcessed?: number;
            errors?: number;
            message?: string;
          };
          
          const response = {
            id: `response-${Date.now()}`,
            ...body,
            timestamp: new Date().toISOString()
          };
          
          // Store sync response for coordination
          await env.SYNC_METADATA.put(`sync-response:${response.id}`, JSON.stringify(response));
          
          // If responding to a specific request, mark it as completed
          if (body.requestId) {
            const requestKey = `sync-request:${body.requestId}`;
            const requestData = await env.SYNC_METADATA.get(requestKey);
            if (requestData) {
              const request = JSON.parse(requestData);
              request.status = body.status;
              request.completedAt = new Date().toISOString();
              await env.SYNC_METADATA.put(requestKey, JSON.stringify(request));
            }
          }
          
          // Record sync response metric
          await metrics.recordMetric({
            timestamp: new Date().toISOString(),
            type: 'sync_response',
            success: body.status === 'completed',
            duration: 0,
            details: {
              responseType: body.type,
              tasksProcessed: body.tasksProcessed || 0,
              errors: body.errors || 0
            }
          });
          
          return new Response(JSON.stringify({
            received: true,
            responseId: response.id,
            timestamp: new Date().toISOString()
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Failed to process sync response',
            message: error instanceof Error ? error.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      if (path === '/sync/migrate-to-batch' && request.method === 'POST') {
        // Require repair auth token for migration
        const authToken = request.headers.get('X-Repair-Auth');
        if (!authToken || authToken !== env.REPAIR_AUTH_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized - valid X-Repair-Auth header required' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }

        const batchSync = new BatchSyncManager(env);
        const dryRun = url.searchParams.get('dry_run') === 'true';
        
        try {
          const startTime = Date.now();
          
          if (dryRun) {
            // Count existing individual keys
            const hashKeys = await env.SYNC_METADATA.list({ prefix: 'hash:' });
            const mappingKeys = await env.SYNC_METADATA.list({ prefix: 'mapping:' });
            
            return new Response(JSON.stringify({
              status: 'dry_run',
              individualKeys: {
                hash: hashKeys.keys.length,
                mapping: mappingKeys.keys.length,
                total: hashKeys.keys.length + mappingKeys.keys.length
              },
              action: 'Would migrate all individual keys to batch format',
              estimatedKvWrites: 1, // Just one write for the batch
              currentKvWritesPerSync: (hashKeys.keys.length + mappingKeys.keys.length) * 2, // Assuming updates
              message: 'Run without dry_run=true to execute migration'
            }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
          }
          
          // Execute migration
          const migrated = await batchSync.migrateFromIndividualKeys();
          
          // Clean up legacy mapping keys
          const mappingKeys = await env.SYNC_METADATA.list({ prefix: 'mapping:' });
          let deletedMappings = 0;
          
          for (const key of mappingKeys.keys) {
            try {
              await env.SYNC_METADATA.delete(key.name);
              deletedMappings++;
            } catch (e) {
              console.error(`Failed to delete ${key.name}:`, e);
            }
          }
          
          return new Response(JSON.stringify({
            status: 'success',
            migrated,
            deletedMappings,
            duration: Date.now() - startTime,
            newBatchSize: await batchSync.getMappingCount(),
            message: `Successfully migrated ${migrated} mappings to batch format`
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Migration failed',
            details: error instanceof Error ? error.message : 'Unknown error'
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

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Override KV with D1-backed adapter
    const d1kv = new D1KV(env.DB);
    env = { ...env, SYNC_METADATA: d1kv as unknown as KVNamespace };
    
    // CF Workers cron-triggered sync - runs every 2 minutes
    console.log('Starting cron-triggered bidirectional sync at:', new Date().toISOString());
    
    const metrics = new MetricsTracker(env);
    const startTime = Date.now();
    let cronLockToken: string | null = null;
    
    try {
      // Check if sync is already locked to prevent concurrent syncs
      const lockKey = 'sync:lock';
      const lockData = await env.SYNC_METADATA.get(lockKey);
      
      if (lockData) {
        const lock = JSON.parse(lockData);
        const lockAge = Date.now() - lock.timestamp;
        
        // If lock is less than 2 minutes old, skip this sync
        if (lockAge < 120000) {
          console.log('Sync already in progress, skipping cron trigger');
          return;
        }
        
        // Lock is stale, clear it
        await env.SYNC_METADATA.delete(lockKey);
      }
      
      // Acquire sync lock
      cronLockToken = await acquireSyncLock(env.SYNC_METADATA);
      if (!cronLockToken) {
        console.log('Another sync is already in progress, skipping cron trigger');
        return;
      }
      
      // STEP 1: Todoist → Things coordination
      // Check if there are new tasks in Todoist that need syncing
      const todoist = new TodoistClient(env);
      const newTodoistTasks = await todoist.getInboxTasks(true, env.SYNC_METADATA);
      
      if (newTodoistTasks.length > 0) {
        console.log(`Found ${newTodoistTasks.length} new Todoist tasks to sync to Things`);
        
        // Create a sync request for local script to process
        const syncRequest = {
          id: `cron-sync-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: 'todoist_to_things',
          tasks: newTodoistTasks.length,
          status: 'pending'
        };
        
        await env.SYNC_METADATA.put(`sync-request:${syncRequest.id}`, JSON.stringify(syncRequest));
        
        // Record metric for coordination
        await metrics.recordMetric({
          timestamp: new Date().toISOString(),
          type: 'sync_coordination',
          success: true,
          duration: Date.now() - startTime,
          details: {
            direction: 'todoist_to_things',
            tasksFound: newTodoistTasks.length,
            requestId: syncRequest.id
          }
        });
      }
      
      // STEP 2: Check for Things sync requests from local scripts
      // This allows the local AppleScript to communicate back to CF Workers
      const syncRequests = await env.SYNC_METADATA.list({ prefix: 'sync-response:' });
      for (const key of syncRequests.keys) {
        try {
          const response = await env.SYNC_METADATA.get(key.name);
          if (response) {
            const syncResponse = JSON.parse(response);
            
            // Process the sync response from local script
            if (syncResponse.type === 'things_to_todoist' && syncResponse.status === 'completed') {
              console.log(`Processing sync response: ${syncResponse.tasksProcessed} tasks from Things`);
              
              // Clean up processed sync response
              await env.SYNC_METADATA.delete(key.name);
            }
          }
        } catch (error) {
          console.error('Error processing sync response:', error);
        }
      }
      
      // STEP 3: Cleanup old sync requests
      const oldRequests = await env.SYNC_METADATA.list({ prefix: 'sync-request:' });
      const cutoffTime = Date.now() - (10 * 60 * 1000); // 10 minutes ago
      
      for (const key of oldRequests.keys) {
        try {
          const request = await env.SYNC_METADATA.get(key.name);
          if (request) {
            const syncRequest = JSON.parse(request);
            if (new Date(syncRequest.timestamp).getTime() < cutoffTime) {
              await env.SYNC_METADATA.delete(key.name);
            }
          }
        } catch (error) {
          console.error('Error cleaning up old sync request:', error);
        }
      }
      
      // Release sync lock
      if (cronLockToken) {
        await releaseSyncLock(env.SYNC_METADATA, cronLockToken);
      }
      
      await metrics.recordMetric({
        timestamp: new Date().toISOString(),
        type: 'cron_sync',
        success: true,
        duration: Date.now() - startTime,
        details: {
          source: 'cf_workers_cron',
          cronPattern: '*/2 * * * *',
          scheduledTime: new Date(event.scheduledTime).toISOString(),
          todoistTasksFound: newTodoistTasks?.length || 0
        }
      });
      
      console.log('Cron sync coordination completed successfully');
    } catch (error) {
      console.error('Cron sync failed:', error);
      
      // Ensure sync lock is released on error
      try {
        if (cronLockToken) {
          await releaseSyncLock(env.SYNC_METADATA, cronLockToken);
        }
      } catch (lockError) {
        console.error('Failed to release sync lock:', lockError);
      }
      
      await metrics.recordMetric({
        timestamp: new Date().toISOString(),
        type: 'cron_sync',
        success: false,
        duration: Date.now() - startTime,
        details: {
          source: 'cf_workers_cron',
          scheduledTime: new Date(event.scheduledTime).toISOString()
        },
        errorMessage: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
};
