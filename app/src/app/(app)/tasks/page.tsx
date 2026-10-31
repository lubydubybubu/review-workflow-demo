import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { formatDateKo, todayInSeoul } from '@/lib/domain/dates';
import { parseTaskListParams } from '@/lib/domain/task';
import { requireSession } from '@/server/auth/session';
import { getPool } from '@/server/db/pool';
import { listLinkableReviews, listTasks } from '@/server/db/tasks';
import { TaskList } from './task-list';

export const metadata: Metadata = { title: '할 일' };

/** `?status=open|todo|in_progress|done|all|archived` × `?due=all|today|overdue|upcoming|none`; anything else is the default. */
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const filter = parseTaskListParams(await searchParams);
  const today = todayInSeoul();
  const db = getPool();
  const [{ items, total }, reviews] = await Promise.all([listTasks(db, { ...filter, today }), listLinkableReviews(db)]);
  return (
    <div className="max-w-4xl">
      <PageHeader title="할 일" meta={`${formatDateKo(today)} · 리뷰와 따로, 또는 리뷰에 연결해 관리합니다`} />
      <TaskList filter={filter} items={items} total={total} reviews={reviews} today={today} />
    </div>
  );
}
