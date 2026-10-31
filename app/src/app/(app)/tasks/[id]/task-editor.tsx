'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import { TaskDue } from '@/components/task-bits';
import { useToast } from '@/components/toast';
import { NotStoredNotice } from '@/components/unsaved-guard';
import type { IsoDate } from '@/lib/domain/dates';
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/domain/review';
import { TASK_DUE_MAX, TASK_DUE_MIN, TASK_MEMO_MAX, TASK_STATUS_LABEL, TASK_STATUSES, TASK_TITLE_MAX } from '@/lib/domain/task';
import { draftKey, useDraftGuard } from '@/lib/draft-guard';
import {
  initialTaskEditor,
  isTaskDraftDirty,
  rebaseTaskEditor,
  TASK_STALE_MESSAGE,
  toTaskForm,
  type TaskEditorState,
  type TaskFormState,
} from '@/lib/task-form';
import { setTaskArchivedAction, setTaskStatusAction, updateTaskAction } from '@/server/actions/tasks';
import type { TaskDetail } from '@/server/db/tasks';

/**
 * The whole task as one form. The draft and the version it is saved against live in ONE state value
 * (`TaskEditorState`): a background refresh may replace both together only while the form is untouched
 * (`rebaseTaskEditor`); with unsaved changes it can refresh neither, so a save after the task changed
 * elsewhere comes back stale instead of overwriting. Only the owner's explicit "최신 내용 불러오기" or
 * "버리기" drops a draft. Leaving the page does not: the draft and its version are kept for this tab and
 * restored on return (`useDraftGuard`); if the browser could not store it, leaving asks first (`@/lib/unsaved`).
 */
export function TaskEditor({ task, reviews, today }: { task: TaskDetail; reviews: { id: number; productName: string }[]; today: IsoDate }) {
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<TaskEditorState>(() => initialTaskEditor(task));
  const [seen, setSeen] = useState(task);
  const [discardOnRefresh, setDiscardOnRefresh] = useState(false);
  const [stale, setStale] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [memoTab, setMemoTab] = useState<'edit' | 'preview'>(task.memoMd ? 'preview' : 'edit');
  const [pending, startTransition] = useTransition();

  // A new `task` prop (revalidation after any action, router.refresh): adjust state during render.
  if (seen !== task) {
    setSeen(task);
    if (discardOnRefresh && task.version !== state.baseVersion) {
      setDiscardOnRefresh(false);
      setStale(false);
      setState(initialTaskEditor(task));
    } else {
      setState((s) => rebaseTaskEditor(s, task));
    }
  }

  // leaving with unsaved changes (link, Back, reload) keeps them for this tab; see draft-guard
  const { restored, dismissRestored, notStored } = useDraftGuard({
    storageKey: draftKey('task', task.id),
    label: '할 일 편집',
    href: `/tasks/${task.id}`,
    draft: state,
    template: toTaskForm(task),
    restore: (stored) => {
      setState(stored);
      if (stored.baseVersion < task.version) setStale(true); // changed elsewhere meanwhile
    },
    discard: () => {
      setStale(false);
      setState(initialTaskEditor(task));
    },
  });

  const { form, baseVersion } = state;
  const dirty = isTaskDraftDirty(state);
  const archived = task.archivedAt !== null;
  const set = <K extends keyof TaskFormState>(key: K, value: TaskFormState[K]) =>
    setState((s) => ({ ...s, form: { ...s.form, [key]: value } }));

  function apply(result: Awaited<ReturnType<typeof setTaskStatusAction>>, message: string) {
    if (!result.ok) {
      setErrors(result.fieldErrors ?? {});
      toast(result.error, { tone: 'error' });
      if (result.error === TASK_STALE_MESSAGE) {
        setStale(true);
        router.refresh(); // brings the newer row; the draft (and its old version) stay as they are
      }
      return;
    }
    setStale(false);
    setState(initialTaskEditor(result.data.task)); // stored values + their version, together
    toast(message);
  }

  function save() {
    setErrors({});
    const loadedReview = state.initial.reviewId ? Number(state.initial.reviewId) : null;
    startTransition(async () => apply(await updateTaskAction(task.id, form, baseVersion, loadedReview), '저장했습니다.'));
  }

  function setStatus(status: 'done' | 'todo') {
    startTransition(async () =>
      apply(await setTaskStatusAction({ id: task.id, status, expectedVersion: baseVersion }), status === 'done' ? '완료했습니다.' : '다시 열었습니다.'),
    );
  }

  function setArchived(next: boolean) {
    startTransition(async () =>
      apply(await setTaskArchivedAction({ id: task.id, archived: next, expectedVersion: baseVersion }), next ? '보관했습니다.' : '보관을 해제했습니다.'),
    );
  }

  function loadLatest() {
    if (task.version !== baseVersion) {
      setStale(false);
      setState(initialTaskEditor(task));
    } else {
      setDiscardOnRefresh(true);
      router.refresh();
    }
  }

  // Ctrl/Cmd+S saves from anywhere on the page.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (formRef.current?.reportValidity()) saveRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const field = (name: keyof TaskFormState) => ({
    id: `${uid}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? `${uid}-${name}-error` : undefined,
  });
  const error = (name: keyof TaskFormState) =>
    errors[name] ? (
      <p id={`${uid}-${name}-error`} className="mt-1 text-[12px] text-danger">
        {errors[name]}
      </p>
    ) : null;

  const linkedId = state.initial.reviewId;
  const linkedMissing = linkedId !== '' && !reviews.some((r) => String(r.id) === linkedId);

  return (
    <form
      ref={formRef}
      aria-label="할 일 편집"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      {archived ? (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-hover px-3 py-2 text-[13px]">
          보관된 할 일입니다. 목록과 대시보드에 나오지 않습니다.
          <button type="button" className="btn h-8" disabled={pending} onClick={() => setArchived(false)}>
            보관 해제
          </button>
        </div>
      ) : null}
      {stale ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {TASK_STALE_MESSAGE} 작성 중인 내용은 아직 이 화면에 남아 있습니다.
          <button type="button" className="btn h-8" onClick={loadLatest}>
            최신 내용 불러오기 (내 변경 버리기)
          </button>
        </div>
      ) : null}
      {restored ? (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-hover px-3 py-2 text-[13px]">
          저장하지 않은 초안을 복원했습니다.
          <button
            type="button"
            className="btn h-8"
            onClick={() => {
              dismissRestored();
              setStale(false);
              setState(initialTaskEditor(task));
            }}
          >
            버리기
          </button>
        </div>
      ) : null}
      {notStored ? <NotStoredNotice /> : null}

      <fieldset disabled={archived || pending} className="min-w-0">
        <label htmlFor={`${uid}-title`} className="sr-only">
          제목
        </label>
        <input
          {...field('title')}
          className="w-full bg-transparent text-[22px] leading-tight font-bold tracking-tight outline-none placeholder:text-subtle md:text-[26px]"
          required
          maxLength={TASK_TITLE_MAX}
          value={form.title}
          onChange={(e) => set('title', e.target.value)}
        />
        {error('title')}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <TaskDue task={task} today={today} />
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {dirty ? <span className="text-[12px] text-muted">저장하지 않은 변경</span> : null}
            {archived ? null : (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={dirty}
                  title={dirty ? '먼저 저장하거나 변경을 되돌리세요.' : undefined}
                  onClick={() => setStatus(task.status === 'done' ? 'todo' : 'done')}
                >
                  {task.status === 'done' ? '다시 열기' : '완료'}
                </button>
                <button type="button" className="btn btn-ghost text-muted" disabled={dirty} onClick={() => setArchived(true)}>
                  보관
                </button>
              </>
            )}
            <button type="submit" className="btn btn-primary" disabled={!dirty || pending}>
              {pending ? '저장 중…' : '저장'}
            </button>
          </span>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-status`} className="label">
              상태
            </label>
            <select {...field('status')} className="input" value={form.status} onChange={(e) => set('status', e.target.value)}>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-priority`} className="label">
              우선순위
            </label>
            <select {...field('priority')} className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-dueOn`} className="label">
              기한
            </label>
            <input
              type="date"
              className="input"
              min={TASK_DUE_MIN}
              max={TASK_DUE_MAX}
              {...field('dueOn')}
              value={form.dueOn}
              onChange={(e) => set('dueOn', e.target.value)}
            />
            {error('dueOn')}
          </div>
          <div>
            <label htmlFor={`${uid}-reviewId`} className="label">
              연결된 리뷰
            </label>
            <select {...field('reviewId')} className="input" value={form.reviewId} onChange={(e) => set('reviewId', e.target.value)}>
              <option value="">연결 없음</option>
              {linkedMissing ? (
                <option value={linkedId}>
                  {task.reviewName ?? `리뷰 #${linkedId}`} {task.reviewArchived ? '(보관된 리뷰 · 연결 유지만 가능)' : ''}
                </option>
              ) : null}
              {reviews.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.productName}
                </option>
              ))}
            </select>
            {error('reviewId')}
            {task.reviewId ? (
              <p className="mt-1 text-[12px] text-muted">
                <Link href={`/reviews/${task.reviewId}`} prefetch={false} className="underline underline-offset-2 hover:text-fg">
                  {task.reviewName}
                </Link>
                {task.reviewArchived ? ' — 보관된 리뷰입니다. 연결은 유지되지만, 연결을 끊으면 다시 연결할 수 없습니다.' : ''}
              </p>
            ) : null}
          </div>
        </div>

        <section aria-labelledby={`${uid}-memo`} className="mt-8">
          <h2 id={`${uid}-memo`} className="section-title">
            메모
            <span role="tablist" aria-label="메모 보기" className="flex gap-3 text-[12px] font-normal">
              {(['edit', 'preview'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={memoTab === tab}
                  className={memoTab === tab ? 'font-semibold text-fg' : 'text-muted hover:text-fg'}
                  onClick={() => setMemoTab(tab)}
                >
                  {tab === 'edit' ? '편집' : '미리보기'}
                </button>
              ))}
            </span>
          </h2>
          <div className="pt-3">
            {memoTab === 'edit' ? (
              <>
                <label htmlFor={`${uid}-memoMd`} className="sr-only">
                  메모 (마크다운)
                </label>
                <textarea
                  {...field('memoMd')}
                  className="input min-h-56 font-mono text-[13px]"
                  maxLength={TASK_MEMO_MAX}
                  placeholder="마크다운으로 적습니다. 예: - [ ] 확인할 것"
                  value={form.memoMd}
                  onChange={(e) => set('memoMd', e.target.value)}
                />
                {error('memoMd')}
              </>
            ) : (
              <div className="prose-ops min-h-24 text-[14px]" data-testid="task-memo-preview">
                {form.memoMd.trim() ? <ReactMarkdown>{form.memoMd}</ReactMarkdown> : <p className="text-muted">메모가 없습니다.</p>}
              </div>
            )}
          </div>
        </section>
      </fieldset>
    </form>
  );
}
