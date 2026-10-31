'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { TASK_STALE_MESSAGE } from '@/lib/task-form';
import { taskArchiveSchema, taskCreateSchema, taskStatusSchema, taskUpdateSchema } from '@/lib/validation';
import { getPool } from '../db/pool';
import {
  createTask,
  setTaskArchived,
  setTaskStatus,
  updateTask,
  type TaskDetail,
  type TaskWriteOutcome,
} from '../db/tasks';
import { runAction, type ActionResult } from './run';

const ARCHIVED_MESSAGE = '보관된 할 일입니다. 보관을 해제한 뒤 수정하세요.';

/**
 * Pages that show tasks: the list, the dashboard and the review(s) the task is linked to (before and after
 * the write). Targeted on purpose: a task write never refreshes the whole layout, and never touches a
 * review row, so an open review form keeps its draft and its version.
 */
function refreshTaskPages(id: number | null, ...reviewIds: (number | null | undefined)[]) {
  revalidatePath('/tasks');
  revalidatePath('/');
  if (id !== null) revalidatePath(`/tasks/${id}`);
  for (const r of new Set(reviewIds)) if (r) revalidatePath(`/reviews/${r}`);
}

function outcome(result: ActionResult<TaskWriteOutcome>, previousReviewId?: number | null): ActionResult<{ task: TaskDetail }> {
  if (!result.ok) return result;
  if (!result.data.ok) return { ok: false, error: result.data.error === 'stale' ? TASK_STALE_MESSAGE : ARCHIVED_MESSAGE };
  const task = result.data.task;
  refreshTaskPages(task.id, task.reviewId, previousReviewId);
  return { ok: true, data: { task } };
}

export async function createTaskAction(raw: unknown): Promise<ActionResult<{ id: number }>> {
  return runAction(taskCreateSchema, raw, async (input) => {
    const id = await createTask(getPool(), input);
    refreshTaskPages(null, input.reviewId);
    return { id };
  });
}

/**
 * Save the task form. `expectedVersion` is the version the form was loaded with (required); a task changed
 * since is not written and the stale message comes back. `previousReviewId` (what the form was loaded with)
 * only decides which review page to refresh after a relink.
 */
export async function updateTaskAction(
  taskId: number,
  raw: unknown,
  expectedVersion: number,
  previousReviewId: number | null = null,
): Promise<ActionResult<{ task: TaskDetail }>> {
  const positive = z.number().int().positive();
  let previous: number | null = null;
  const result = await runAction(
    z.object({ id: positive, input: taskUpdateSchema, expectedVersion: positive, previousReviewId: positive.nullable() }),
    { id: taskId, input: raw, expectedVersion, previousReviewId },
    (v) => {
      previous = v.previousReviewId;
      return updateTask(getPool(), v.id, v.input, v.expectedVersion);
    },
  );
  if (!result.ok && result.fieldErrors) {
    // the form's fields, keyed like the form (not `input.title`)
    const fieldErrors = Object.fromEntries(Object.entries(result.fieldErrors).map(([k, v]) => [k.replace(/^input\./, ''), v]));
    return { ...result, fieldErrors };
  }
  return outcome(result, previous);
}

/** 완료 / 다시 열기: moves the task's stage only (never the linked review, never the memo). */
export async function setTaskStatusAction(raw: unknown): Promise<ActionResult<{ task: TaskDetail }>> {
  return outcome(await runAction(taskStatusSchema, raw, (v) => setTaskStatus(getPool(), v.id, v.status, v.expectedVersion)));
}

/** 보관 / 보관 해제 (soft; there is no delete). */
export async function setTaskArchivedAction(raw: unknown): Promise<ActionResult<{ task: TaskDetail }>> {
  return outcome(await runAction(taskArchiveSchema, raw, (v) => setTaskArchived(getPool(), v.id, v.archived, v.expectedVersion)));
}
