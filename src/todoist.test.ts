import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TodoistClient } from './todoist';
import { Env, TodoistTask } from './types';

describe('TodoistClient', () => {
  let env: Env;

  beforeEach(() => {
    env = {
      TODOIST_API_URL: 'https://api.todoist.com',
      TODOIST_API_TOKEN: 'test-token',
      SYNC_METADATA: {} as any
    } as Env;
    vi.resetAllMocks();
  });

  describe('closeTask', () => {
    it('should handle 204 response without throwing', async () => {
      const task: TodoistTask = {
        id: '123',
        project_id: '1',
        content: 'Test task',
        description: '',
        priority: 1,
        labels: [],
        created_at: new Date().toISOString(),
        creator_id: 'user',
        comment_count: 0,
        is_completed: false,
        url: 'https://todoist.com'
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(task), { status: 200 })
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const originalFetch = global.fetch;
      // @ts-ignore
      global.fetch = fetchMock;

      const client = new TodoistClient(env);
      await expect(client.closeTask('123')).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Restore original fetch
      global.fetch = originalFetch;
    });
  });
});
