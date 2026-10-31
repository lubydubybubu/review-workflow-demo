import Link from 'next/link';
import { diffDays, formatDateShort, type IsoDate } from '@/lib/domain/dates';
import { PRIORITY_LABEL, type Priority } from '@/lib/domain/review';
import { taskDueState, type TaskStatus } from '@/lib/domain/task';

/** `오늘` / `지연 · 3일 지남` / `10.24` / nothing, relative to the KST `today`. */
export function TaskDue({ task, today }: { task: { status: TaskStatus; dueOn: IsoDate | null }; today: IsoDate }) {
  if (!task.dueOn) return null;
  const state = taskDueState(task, today);
  const date = formatDateShort(task.dueOn, today);
  if (state === 'overdue') {
    return (
      <span className="whitespace-nowrap text-[12px] font-medium text-danger">
        {date} · {diffDays(task.dueOn, today)}일 지남
      </span>
    );
  }
  if (state === 'today') return <span className="whitespace-nowrap text-[12px] font-semibold text-accent">오늘 마감</span>;
  return <span className="whitespace-nowrap text-[12px] text-muted tabular-nums">{date}</span>;
}

export function TaskPriority({ priority }: { priority: Priority }) {
  if (priority === 'normal') return null;
  return (
    <span
      className={`inline-flex items-center rounded-sm px-1.5 text-[11px] font-semibold ${
        priority === 'high' ? 'bg-danger-soft text-danger' : 'bg-hover text-muted'
      }`}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

/** The linked review: a plain link (no prefetch), clearly marked when the review has been archived since. */
export function TaskReviewLink({ reviewId, reviewName, reviewArchived }: { reviewId: number | null; reviewName: string | null; reviewArchived: boolean }) {
  if (!reviewId) return null;
  return (
    <Link
      href={`/reviews/${reviewId}`}
      prefetch={false}
      className="inline-flex min-w-0 items-center gap-1 text-[12px] text-muted hover:text-fg"
      title={reviewArchived ? '보관된 리뷰입니다. 연결은 유지되지만 새 할 일을 연결할 수는 없습니다.' : undefined}
    >
      <span className="truncate">↳ {reviewName}</span>
      {reviewArchived ? <span className="shrink-0 rounded-sm border border-line px-1 text-[11px]">보관된 리뷰</span> : null}
    </Link>
  );
}
