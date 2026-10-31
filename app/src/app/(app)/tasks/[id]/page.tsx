import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { formatInstantKo, todayInSeoul } from '@/lib/domain/dates';
import { requireSession } from '@/server/auth/session';
import { getPool } from '@/server/db/pool';
import { getTask, listLinkableReviews } from '@/server/db/tasks';
import { loadSettings } from '@/server/queries';
import { TaskEditor } from './task-editor';

type Props = { params: Promise<{ id: string }> };

/** Per-request memo (React `cache`): metadata and page share one read of the task. */
const load = cache(async (idParam: string) => {
  await requireSession();
  if (!/^[1-9]\d{0,14}$/.test(idParam)) notFound();
  const task = await getTask(getPool(), Number(idParam));
  if (!task) notFound();
  return task;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const task = await load((await params).id);
  return { title: task.title };
}

export default async function TaskPage({ params }: Props) {
  const task = await load((await params).id);
  const [reviews, settings] = await Promise.all([listLinkableReviews(getPool()), loadSettings()]);
  return (
    <div className="mx-auto max-w-3xl">
      <nav aria-label="경로" className="mb-3 text-[12px] text-muted">
        <Link href="/tasks" prefetch={false} className="hover:text-fg">
          할 일
        </Link>
        <span className="mx-1.5 text-subtle">/</span>
        <span>{task.title}</span>
      </nav>
      {/* keyed by id only: a background refresh with a new version must not remount (and drop) an unsaved draft */}
      <TaskEditor key={task.id} task={task} reviews={reviews} today={todayInSeoul()} />
      <p className="mt-8 text-[12px] text-subtle">
        만든 날 {formatInstantKo(task.createdAt, settings.timeFormat24h)} · 고친 날 {formatInstantKo(task.updatedAt, settings.timeFormat24h)}
        {task.completedAt ? <> · 완료 {formatInstantKo(task.completedAt, settings.timeFormat24h)}</> : null}
      </p>
    </div>
  );
}
