import { describe, it, expect, vi, afterEach } from 'vitest';
import { convertToThingsFormat } from './things';
import type { TodoistTask } from './types';

function buildTask(dueDate: string, id: string = '1'): TodoistTask {
  return {
    id,
    project_id: 'p1',
    content: 'Task',
    description: '',
    priority: 1,
    due: { date: dueDate, string: '', lang: 'en', is_recurring: false },
    labels: [],
    created_at: '',
    creator_id: '',
    comment_count: 0,
    is_completed: false,
    url: ''
  };
}

describe('convertToThingsFormat date handling', () => {
  const originalTZ = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTZ;
    vi.useRealTimers();
  });

  it('marks task due today as today in local timezone', () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T10:00:00Z'));

    const result = convertToThingsFormat([buildTask('2024-01-01')]);

    expect(result[0].attributes.when).toBe('today');
    expect(result[0].attributes.deadline).toBeUndefined();
  });

  it('handles dates around midnight in earlier timezone', () => {
    process.env.TZ = 'America/New_York';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:30:00Z'));

    const result = convertToThingsFormat([
      buildTask('2023-12-31', 'a'),
      buildTask('2024-01-01', 'b')
    ]);

    expect(result[0].attributes.when).toBe('today');
    expect(result[1].attributes.when).toBeUndefined();
    expect(result[1].attributes.deadline).toBe('2024-01-01');
  });

  it('handles dates around midnight in later timezone', () => {
    process.env.TZ = 'Asia/Tokyo';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2023-12-31T15:30:00Z'));

    const result = convertToThingsFormat([
      buildTask('2023-12-31', 'c'),
      buildTask('2024-01-01', 'd')
    ]);

    expect(result[0].attributes.when).toBeUndefined();
    expect(result[0].attributes.deadline).toBe('2023-12-31');
    expect(result[1].attributes.when).toBe('today');
  });
});
