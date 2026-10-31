'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { TaskDue, TaskPriority, TaskReviewLink } from '@/components/task-bits';
import { useToast } from '@/components/toast';
import type { IsoDate } from '@/lib/domain/dates';
import { PRIORITIES, PRIORITY_LABEL } from '@/lib/domain/review';
import {
  TASK_DUE_FILTER_LABEL,
  TASK_DUE_FILTERS,
  TASK_DUE_MAX,
  TASK_DUE_MIN,
  TASK_STATUS_FILTER_LABEL,
  TASK_STATUS_FILTERS,
  TASK_STATUS_LABEL,
  TASK_TITLE_MAX,
  taskListHref,
  type TaskDueFilter,
  type TaskStatusFilter,
} from '@/lib/domain/task';
import { useKeptOwner } from '@/lib/draft-guard';
import { carriedForm } from '@/lib/recovery';
import { TASK_STALE_MESSAGE } from '@/lib/task-form';
import { createTaskAction, setTaskArchivedAction, setTaskStatusAction } from '@/server/actions/tasks';
import type { TaskListItem } from '@/server/db/tasks';

type Filter = { status: TaskStatusFilter; due: TaskDueFilter };

export function TaskList({
  filter,
  items,
  total,
  reviews,
  today,
}: {
  filter: Filter;
  items: TaskListItem[];
  total: number;
  reviews: { id: number; productName: string }[];
  today: IsoDate;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  /** Every row action carries the version the row was rendered with; a stale row is refreshed, never forced. */
  function run(id: number, action: () => ReturnType<typeof setTaskStatusAction>, done: (r: TaskListItem) => void) {
    setBusy(id);
    startTransition(async () => {
      const result = await action();
      setBusy(null);
      if (!result.ok) {
        toast(result.error, { tone: 'error' });
        if (result.error === TASK_STALE_MESSAGE) router.refresh();
        return;
      }
      done(result.data.task);
    });
  }

  function toggleDone(t: TaskListItem) {
    const status = t.status === 'done' ? 'todo' : 'done';
    run(t.id, () => setTaskStatusAction({ id: t.id, status, expectedVersion: t.version }), (saved) =>
      toast(status === 'done' ? `‘${t.title}’ 완료` : `‘${t.title}’ 다시 열었습니다.`, {
        action: {
          label: '되돌리기',
          onClick: () => void setTaskStatusAction({ id: t.id, status: t.status, expectedVersion: saved.version }).then((r) => !r.ok && toast(r.error, { tone: 'error' })),
        },
      }),
    );
  }

  function setArchived(t: TaskListItem, archived: boolean) {
    run(t.id, () => setTaskArchivedAction({ id: t.id, archived, expectedVersion: t.version }), () =>
      toast(archived ? `‘${t.title}’을(를) 보관했습니다.` : '보관을 해제했습니다.'),
    );
  }

  const isDefault = filter.status === 'open' && filter.due === 'all';

  return (
    <>
      <CreateTaskForm reviews={reviews} />

      <div className="mt-6 flex flex-col gap-2">
        <FilterLinks
          label="상태"
          values={TASK_STATUS_FILTERS}
          labels={TASK_STATUS_FILTER_LABEL}
          current={filter.status}
          href={(status) => taskListHref({ ...filter, status })}
        />
        <FilterLinks
          label="기한"
          values={TASK_DUE_FILTERS}
          labels={TASK_DUE_FILTER_LABEL}
          current={filter.due}
          href={(due) => taskListHref({ ...filter, due })}
        />
      </div>

      <h2 className="section-title mt-6" id="task-list-title">
        {TASK_STATUS_FILTER_LABEL[filter.status]} · {TASK_DUE_FILTER_LABEL[filter.due]}
        <span className="text-[12px] font-normal text-muted tabular-nums" data-testid="task-total">
          {total}개
        </span>
      </h2>
      {total > items.length ? (
        <p role="status" className="mt-2 text-[12px] text-muted">
          {total}개 중 앞의 {items.length}개만 표시합니다. 필터로 좁혀 보세요.
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-muted" data-testid="task-empty">
          {isDefault ? (
            <p>아직 할 일이 없습니다. 위 입력란에서 첫 할 일을 추가해 보세요.</p>
          ) : (
            <>
              <p>이 조건에 맞는 할 일이 없습니다.</p>
              <Link href="/tasks" prefetch={false} className="mt-2 inline-block text-fg underline underline-offset-2">
                미완료 할 일 모두 보기
              </Link>
            </>
          )}
        </div>
      ) : (
        <ul aria-labelledby="task-list-title" className="mt-1 divide-y divide-line">
          {items.map((t) => {
            const archived = t.archivedAt !== null;
            return (
              <li key={t.id} data-task-id={t.id} className="flex items-start gap-3 py-2.5" aria-busy={busy === t.id || undefined}>
                <input
                  type="checkbox"
                  id={`task-done-${t.id}`}
                  className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
                  checked={t.status === 'done'}
                  disabled={archived || busy === t.id}
                  onChange={() => toggleDone(t)}
                  aria-label={t.status === 'done' ? `‘${t.title}’ 다시 열기` : `‘${t.title}’ 완료`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Link
                      href={`/tasks/${t.id}`}
                      prefetch={false}
                      className={`min-w-0 break-words font-medium hover:underline ${t.status === 'done' ? 'text-subtle line-through' : ''}`}
                    >
                      {t.title}
                    </Link>
                    <TaskPriority priority={t.priority} />
                    {t.status === 'in_progress' ? <span className="text-[12px] text-accent">{TASK_STATUS_LABEL.in_progress}</span> : null}
                    {archived ? <span className="rounded-sm border border-line px-1 text-[11px] text-muted">보관됨</span> : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                    <TaskDue task={t} today={today} />
                    <TaskReviewLink reviewId={t.reviewId} reviewName={t.reviewName} reviewArchived={t.reviewArchived} />
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost h-8 shrink-0 px-2 text-[12px] text-muted"
                  disabled={busy === t.id}
                  onClick={() => setArchived(t, !archived)}
                >
                  {archived ? '보관 해제' : '보관'}
                  <span className="sr-only"> ‘{t.title}’</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function FilterLinks<T extends string>({
  label,
  values,
  labels,
  current,
  href,
}: {
  label: string;
  values: readonly T[];
  labels: Record<T, string>;
  current: T;
  href: (value: T) => string;
}) {
  return (
    <nav aria-label={`${label} 필터`} className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-0.5">
      <span className="mr-1 shrink-0 text-[12px] text-subtle">{label}</span>
      {values.map((v) => (
        <Link
          key={v}
          href={href(v)}
          prefetch={false}
          aria-current={v === current ? 'page' : undefined}
          className={`inline-flex h-7 shrink-0 items-center rounded-full border px-3 text-[12px] ${
            v === current ? 'border-fg font-semibold text-fg' : 'border-line text-muted hover:text-fg'
          }`}
        >
          {labels[v]}
        </Link>
      ))}
    </nav>
  );
}

/** Quick add: title (+ optional due date, priority, review). Enter saves; the draft stays on an error. */
function CreateTaskForm({ reviews }: { reviews: { id: number; productName: string }[] }) {
  const toast = useToast();
  const uid = useId();
  const [pending, startTransition] = useTransition();
  const empty = { title: '', dueOn: '', priority: 'normal', reviewId: '' };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof empty, value: string) => setForm((f) => ({ ...f, [key]: value }));
  // a title or date typed but not added: leaving the page asks; browser Back / Forward keeps it for this tab; an
  // ended session carries it to the next sign-in (the review / priority chosen stay for the next task by design, and
  // are not input on their own)
  const dirty = form.title.trim() !== '' || form.dueOn !== '';
  useKeptOwner({
    label: '새 할 일',
    scope: 'route',
    dirty,
    discard: () => setForm((f) => ({ ...f, title: '', dueOn: '' })),
    recovery: {
      key: 'task-create',
      href: '/tasks',
      data: dirty ? { initial: empty, form } : undefined,
      restore: (data) => {
        const carried = carriedForm(data, empty, { title: TASK_TITLE_MAX });
        if (carried) setForm(carried.form);
      },
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    startTransition(async () => {
      const result = await createTaskAction(form);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? { _: result.error });
        toast(result.error, { tone: 'error' });
        return;
      }
      // keep the chosen review / priority for the next one; the title and date start over
      setForm((f) => ({ ...f, title: '', dueOn: '' }));
      toast('할 일을 추가했습니다.');
    });
  }

  const describe = (name: string) => (errors[name] ? { 'aria-invalid': true, 'aria-describedby': `${uid}-${name}-error` } : {});
  const error = (name: string) =>
    errors[name] ? (
      <p id={`${uid}-${name}-error`} className="mt-1 text-[12px] text-danger">
        {errors[name]}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} aria-label="새 할 일" className="rounded-lg border border-line p-3">
      <fieldset disabled={pending} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem] md:grid-cols-[minmax(0,1fr)_9.5rem_6.5rem_minmax(0,11rem)_auto]">
        <div className="sm:col-span-2 md:col-span-1">
          <label htmlFor={`${uid}-title`} className="sr-only">
            새 할 일 제목
          </label>
          <input
            id={`${uid}-title`}
            className="input"
            placeholder="새 할 일 — 입력 후 Enter"
            required
            maxLength={TASK_TITLE_MAX}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            {...describe('title')}
          />
          {error('title')}
        </div>
        <div>
          <label htmlFor={`${uid}-due`} className="sr-only">
            기한
          </label>
          <input
            id={`${uid}-due`}
            type="date"
            className="input"
            min={TASK_DUE_MIN}
            max={TASK_DUE_MAX}
            value={form.dueOn}
            onChange={(e) => set('dueOn', e.target.value)}
            {...describe('dueOn')}
          />
          {error('dueOn')}
        </div>
        <div>
          <label htmlFor={`${uid}-priority`} className="sr-only">
            우선순위
          </label>
          <select id={`${uid}-priority`} className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2 md:col-span-1">
          <label htmlFor={`${uid}-review`} className="sr-only">
            연결할 리뷰
          </label>
          <select id={`${uid}-review`} className="input" value={form.reviewId} onChange={(e) => set('reviewId', e.target.value)} {...describe('reviewId')}>
            <option value="">리뷰 연결 없음</option>
            {reviews.map((r) => (
              <option key={r.id} value={r.id}>
                {r.productName}
              </option>
            ))}
          </select>
          {error('reviewId')}
        </div>
        <button type="submit" className="btn btn-primary sm:col-span-2 md:col-span-1">
          {pending ? '추가 중…' : '추가'}
        </button>
      </fieldset>
      {errors._ ? (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {errors._}
        </p>
      ) : null}
    </form>
  );
}
