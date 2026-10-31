import type { IsoDate } from './dates';
import { CATEGORY_KEYS, CATEGORY_LABEL, type CategoryKey } from './review';

/** A task's status is the category of its (fixed, one-per-category) task stage. */
export const TASK_STATUSES = CATEGORY_KEYS;
export type TaskStatus = CategoryKey;
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = CATEGORY_LABEL;

/** Due dates a task may carry (also a CHECK in 009-tasks.sql). */
export const TASK_DUE_MIN = '2000-01-01';
export const TASK_DUE_MAX = '2099-12-31';

export const TASK_TITLE_MAX = 200;
export const TASK_MEMO_MAX = 20_000;

/** `open` = not done (할 일 + 진행 중), the default list. `archived` shows only archived tasks. */
export const TASK_STATUS_FILTERS = ['open', 'todo', 'in_progress', 'done', 'all', 'archived'] as const;
export type TaskStatusFilter = (typeof TASK_STATUS_FILTERS)[number];
export const TASK_STATUS_FILTER_LABEL: Record<TaskStatusFilter, string> = {
  open: '미완료',
  todo: '할 일',
  in_progress: '진행 중',
  done: '완료',
  all: '전체',
  archived: '보관됨',
};

export const TASK_DUE_FILTERS = ['all', 'today', 'overdue', 'upcoming', 'none'] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];
export const TASK_DUE_FILTER_LABEL: Record<TaskDueFilter, string> = {
  all: '전체 기한',
  today: '오늘',
  overdue: '지연',
  upcoming: '예정',
  none: '기한 없음',
};

export type TaskDueState = 'overdue' | 'today' | 'upcoming' | 'none';

/**
 * Where a task stands against its KST due day. A done task has no deadline pressure (null). The SQL in
 * `server/db/tasks.ts` (DUE_SQL) mirrors this rule; an integration test keeps the two in sync.
 */
export function taskDueState(task: { status: TaskStatus; dueOn: IsoDate | null }, today: IsoDate): TaskDueState | null {
  if (task.status === 'done') return null;
  if (task.dueOn === null) return 'none';
  if (task.dueOn < today) return 'overdue';
  return task.dueOn === today ? 'today' : 'upcoming';
}

const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** `/tasks?status=…&due=…`: anything unknown (or repeated) falls back to the default list. */
export function parseTaskListParams(params: Record<string, string | string[] | undefined>): {
  status: TaskStatusFilter;
  due: TaskDueFilter;
} {
  return { status: pick(TASK_STATUS_FILTERS, params.status, 'open'), due: pick(TASK_DUE_FILTERS, params.due, 'all') };
}

/** The list URL for a filter pair (defaults omitted so the plain `/tasks` stays canonical). */
export function taskListHref({ status, due }: { status: TaskStatusFilter; due: TaskDueFilter }): string {
  const q = new URLSearchParams();
  if (status !== 'open') q.set('status', status);
  if (due !== 'all') q.set('due', due);
  const s = q.toString();
  return s ? `/tasks?${s}` : '/tasks';
}
