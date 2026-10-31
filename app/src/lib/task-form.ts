import type { TaskDetail } from '@/server/db/tasks';
import { isDraftDirty, openDraft, rebaseDraft, type EditorDraft } from './editor-draft';

/** The task edit form as strings, exactly what `taskUpdateSchema` parses. */
export interface TaskFormState {
  title: string;
  status: string;
  priority: string;
  dueOn: string;
  reviewId: string;
  memoMd: string;
}

export function toTaskForm(t: TaskDetail): TaskFormState {
  return {
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueOn: t.dueOn ?? '',
    reviewId: t.reviewId ? String(t.reviewId) : '',
    memoMd: t.memoMd,
  };
}

/** The task editor's draft paired with its version (see `EditorDraft`). */
export type TaskEditorState = EditorDraft<TaskFormState>;

export function initialTaskEditor(task: TaskDetail): TaskEditorState {
  return openDraft(toTaskForm(task), task.version);
}

export const isTaskDraftDirty: (state: TaskEditorState) => boolean = isDraftDirty;

/** A background re-render brought `latest`: see `rebaseDraft` (untouched follows, a draft keeps its version). */
export function rebaseTaskEditor(state: TaskEditorState, latest: TaskDetail): TaskEditorState {
  return rebaseDraft(state, latest.version, () => toTaskForm(latest));
}

/** Shown when a task save is refused because the task changed elsewhere since the form was loaded. */
export const TASK_STALE_MESSAGE = '다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요.';
