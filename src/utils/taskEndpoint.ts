import type { Task } from '../types';
import { classifyGenerationFailure } from './taskFailure';

/** Preserve recorded endpoints; never invent a host for historical tasks. */
export function getHistoryApiEndpoint(task: Task): string {
  if (task.task_type === 'vision_understanding') return 'BYOK 视觉模型（用户自配，非服务端计费）';
  const endpoints = [...new Set(task.sub_tasks.map(sub =>
    classifyGenerationFailure({ detail: sub.error_detail, message: sub.error }).technical?.endpoint,
  ).filter((endpoint): endpoint is string => Boolean(endpoint)))];
  if (endpoints.length) return endpoints.map(endpoint => `POST ${endpoint}`).join('\n');
  if (task.task_type === 'edit') return 'POST /v1/images/edits';
  if (task.task_type === 'remove_background') return 'POST https://api.remove.bg/v1.0/removebg';
  return 'POST /v1/images/generations';
}
