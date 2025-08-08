import { TodoistTask, ThingsTask } from './types';

export function convertToThingsFormat(todoistTasks: TodoistTask[]): ThingsTask[] {
  return todoistTasks.map(task => {
    const thingsTask: ThingsTask = {
      type: 'to-do',
      attributes: {
        title: task.content,
      }
    };

    if (task.description) {
      thingsTask.attributes.notes = task.description;
    }

    if (task.due) {
      if (task.due.date === new Date().toISOString().split('T')[0]) {
        thingsTask.attributes.when = 'today';
      } else if (task.due.datetime) {
        thingsTask.attributes.deadline = task.due.datetime;
      } else {
        thingsTask.attributes.deadline = task.due.date;
      }
    }

    if (task.labels.length > 0) {
      // Strip sync-only tags from user-facing import
      thingsTask.attributes.tags = task.labels.filter(l => l !== 'synced-to-things' && l !== 'synced-from-things');
    }

    return thingsTask;
  });
}

export function generateThingsUrl(tasks: ThingsTask[]): string {
  const jsonData = JSON.stringify(tasks);
  const encodedData = encodeURIComponent(jsonData);
  return `things:///json?data=${encodedData}`;
}