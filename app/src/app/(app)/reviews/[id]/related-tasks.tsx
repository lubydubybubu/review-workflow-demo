'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { TaskDue, TaskPriority } from '@/components/task-bits';
import { useToast } from '@/components/toast';
import type { IsoDate } from '@/lib/domain/dates';
import { TASK_DUE_MAX, TASK_DUE_MIN, TASK_TITLE_MAX } from '@/lib/domain/task';
import { useKeptOwner } from '@/lib/draft-guard';
import { carriedForm } from '@/lib/recovery';
import { TASK_STALE_MESSAGE } from '@/lib/task-form';
import { createTaskAction, setTaskStatusAction } from '@/server/actions/tasks';
import type { ReviewTasks, TaskListItem } from '@/server/db/tasks';

/**
 * Tasks linked to this review, and a quick "add a linked task". These actions write the tasks table only
 * and refresh the page. The refresh may still bring a review another tab saved meanwhile; the review form
 * next to this never remounts for it and keeps an unsaved draft with its own version (`rebaseReviewEditor`).
 * Counts are exact; the list itself is bounded.
 */
export function RelatedTasks({
  reviewId,
  tasks: { items: tasks, total, open },
  archived,
  today,
}: {
  reviewId: number;
  tasks: ReviewTasks;
  archived: boolean;
  today: IsoDate;
}) {
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  // a task typed but not added: leaving the page asks; browser Back / Forward keeps it for this tab; an ended
  // session carries it to the next sign-in
  const dirty = !archived && (title.trim() !== '' || dueOn !== '');
  useKeptOwner({
    label: '연결된 할 일 추가',
    scope: 'route',
    dirty,
    discard: () => {
      setTitle('');
      setDueOn('');
    },
    recovery: {
      key: `review-task-add:${reviewId}`,
      href: `/reviews/${reviewId}`,
      data: dirty ? { initial: { title: '', dueOn: '' }, form: { title, dueOn } } : undefined,
      restore: (data) => {
        const carried = carriedForm(data, { title: '', dueOn: '' }, { title: TASK_TITLE_MAX });
        if (!carried) return;
        setTitle(carried.form.title);
        setDueOn(carried.form.dueOn);
      },
    },
  });

  function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await createTaskAction({ title, dueOn, reviewId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTitle('');
      setDueOn('');
      toast('연결된 할 일을 추가했습니다.');
    });
  }

  function toggle(t: TaskListItem) {
    startTransition(async () => {
      const result = await setTaskStatusAction({ id: t.id, status: t.status === 'done' ? 'todo' : 'done', expectedVersion: t.version });
      if (!result.ok) {
        toast(result.error, { tone: 'error' });
        if (result.error === TASK_STALE_MESSAGE) router.refresh();
      }
    });
  }

  return (
    <section aria-labelledby={`${uid}-title`} data-testid="related-tasks">
      <h2 id={`${uid}-title`} className="section-title">
        할 일
        <span className="text-[12px] font-normal text-muted tabular-nums">
          남은 {open} / {total}
        </span>
      </h2>
      {total === 0 ? <p className="py-2 text-[13px] text-muted">연결된 할 일이 없습니다.</p> : null}
      {total > tasks.length ? (
        <p className="py-1 text-[12px] text-muted" data-testid="related-tasks-capped">
          {total}건 중 {tasks.length}건만 표시합니다 (남은 일 먼저).
        </p>
      ) : null}
      <ul className="mt-1">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-2.5 py-1.5 text-[13px]">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
              checked={t.status === 'done'}
              disabled={pending}
              aria-label={t.status === 'done' ? `‘${t.title}’ 다시 열기` : `‘${t.title}’ 완료`}
              onChange={() => toggle(t)}
            />
            <span className="min-w-0 flex-1">
              <Link
                href={`/tasks/${t.id}`}
                prefetch={false}
                className={`break-words hover:underline ${t.status === 'done' ? 'text-subtle line-through' : ''}`}
              >
                {t.title}
              </Link>{' '}
              <TaskPriority priority={t.priority} /> <TaskDue task={t} today={today} />
            </span>
          </li>
        ))}
      </ul>
      {archived ? (
        <p className="mt-2 text-[12px] text-muted">보관된 리뷰에는 할 일을 새로 연결할 수 없습니다. 기존 할 일은 그대로 남습니다.</p>
      ) : (
        <form onSubmit={add} className="mt-2 flex flex-col gap-1.5" aria-label="이 리뷰에 할 일 만들기">
          <label htmlFor={`${uid}-new`} className="sr-only">
            연결된 할 일 추가
          </label>
          <input
            id={`${uid}-new`}
            className="input h-8 text-[13px]"
            placeholder="할 일 추가 후 Enter"
            maxLength={TASK_TITLE_MAX}
            required
            disabled={pending}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="flex gap-1.5">
            <label htmlFor={`${uid}-due`} className="sr-only">
              연결된 할 일 기한
            </label>
            <input
              id={`${uid}-due`}
              type="date"
              className="input h-8 flex-1 text-[13px]"
              min={TASK_DUE_MIN}
              max={TASK_DUE_MAX}
              disabled={pending}
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
            />
            <button type="submit" className="btn h-8" disabled={pending}>
              추가
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-[12px] text-danger">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  );
}
