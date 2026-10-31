import type { IsoDate, IsoInstant } from '@/lib/domain/dates';
import type { Priority } from '@/lib/domain/review';
import type { TaskDueFilter, TaskStatus, TaskStatusFilter } from '@/lib/domain/task';
import type { TaskCreateInput, TaskUpdateInput } from '@/lib/validation';
import type { Queryable } from './client';
import { NotFoundError } from './reviews';

export interface TaskListItem {
  id: number;
  title: string;
  status: TaskStatus;
  stageName: string;
  priority: Priority;
  dueOn: IsoDate | null;
  reviewId: number | null;
  reviewName: string | null;
  /** the linked review was archived after the link was made (the link is kept, shown as 보관됨) */
  reviewArchived: boolean;
  completedAt: IsoInstant | null;
  archivedAt: IsoInstant | null;
  updatedAt: IsoInstant;
  /** row revision (bumped by a trigger on every update): every task writer is checked against it */
  version: number;
}

export interface TaskDetail extends TaskListItem {
  memoMd: string;
  createdAt: IsoInstant;
}

const LIST_COLUMNS = `
  t.id, t.title, s.category_key as status, s.name as "stageName", t.priority, t.due_on as "dueOn",
  t.review_id as "reviewId", r.product_name as "reviewName", (r.archived_at is not null) as "reviewArchived",
  t.completed_at as "completedAt", t.archived_at as "archivedAt", t.updated_at as "updatedAt", t.version`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, t.memo_md as "memoMd", t.created_at as "createdAt"`;

/** Joins for `t` (a tasks row; also the RETURNING set of a write). */
const JOINS = `
  join workflow_stages s on s.id = t.stage_id
  left join reviews r on r.id = t.review_id`;

/** The fixed task stage for a status (one per category; the default first, should more ever exist). */
const STAGE_FOR_STATUS = (p: string) =>
  `(select id from workflow_stages where entity_type = 'task' and category_key = ${p} and archived_at is null
     order by is_default desc, sort limit 1)`;

/**
 * Due-filter predicates over `t` / `s` for a KST `today` bind parameter. Mirrors `taskDueState`:
 * a done task is never today / overdue / upcoming.
 */
const DUE_SQL: Record<Exclude<TaskDueFilter, 'all'>, (today: string) => string> = {
  today: (p) => `s.category_key <> 'done' and t.due_on = ${p}`,
  overdue: (p) => `s.category_key <> 'done' and t.due_on < ${p}`,
  upcoming: (p) => `s.category_key <> 'done' and t.due_on > ${p}`,
  none: () => `t.due_on is null`,
};

/** Earliest due first (overdue on top), no date last, then priority, newest. */
const ORDER = `t.due_on asc nulls last, array_position(array['high','normal','low'], t.priority), t.id desc`;

// ---------------------------------------------------------------- write

export async function createTask(db: Queryable, input: TaskCreateInput, status: TaskStatus = 'todo'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into tasks (title, stage_id, priority, due_on, review_id, memo_md)
     values ($1, ${STAGE_FOR_STATUS('$2')}, $3, $4, $5, $6)
     returning id`,
    [input.title, status, input.priority, input.dueOn, input.reviewId, input.memoMd],
  );
  return rows[0]!.id;
}

export type TaskWriteOutcome = { ok: true; task: TaskDetail } | { ok: false; error: 'stale' | 'archived' };

/**
 * One compare-and-set UPDATE: `set` applies only while the row still has `expectedVersion` (and, unless
 * `allowArchived`, is not archived). Zero rows → classify why: unknown id throws NotFoundError, a moved
 * version is `stale` (checked first: a form that never saw the archive should hear "changed elsewhere"),
 * otherwise `archived`. Concurrent writers with the same version serialize on the row lock; the loser
 * re-checks the WHERE against the new version and writes nothing.
 */
async function casUpdate(
  db: Queryable,
  id: number,
  expectedVersion: number,
  set: string,
  values: unknown[],
  { allowArchived = false } = {},
): Promise<TaskWriteOutcome> {
  const n = values.length;
  const { rows } = await db.query<TaskDetail>(
    `with t as (
       update tasks set ${set}
        where id = $${n + 1} and version = $${n + 2} ${allowArchived ? '' : 'and archived_at is null'}
        returning *
     )
     select ${DETAIL_COLUMNS} from t ${JOINS}`,
    [...values, id, expectedVersion],
  );
  if (rows[0]) return { ok: true, task: rows[0] };
  const { rows: current } = await db.query<{ version: number; archived: boolean }>(
    'select version, archived_at is not null as archived from tasks where id = $1',
    [id],
  );
  if (!current[0]) throw new NotFoundError('task');
  return { ok: false, error: current[0].version !== expectedVersion ? 'stale' : 'archived' };
}

/** Save the task form (title, status, priority, due, review link, memo) against the version it was loaded with. */
export function updateTask(db: Queryable, id: number, input: TaskUpdateInput, expectedVersion: number): Promise<TaskWriteOutcome> {
  return casUpdate(
    db,
    id,
    expectedVersion,
    `title = $1, stage_id = ${STAGE_FOR_STATUS('$2')}, priority = $3, due_on = $4, review_id = $5, memo_md = $6`,
    [input.title, input.status, input.priority, input.dueOn, input.reviewId, input.memoMd],
  );
}

/** 완료 / 다시 열기 / 진행 중: only the stage moves; title, memo and the linked review are untouched. */
export function setTaskStatus(db: Queryable, id: number, status: TaskStatus, expectedVersion: number): Promise<TaskWriteOutcome> {
  return casUpdate(db, id, expectedVersion, `stage_id = ${STAGE_FOR_STATUS('$1')}`, [status]);
}

/** Soft archive / restore (the app never deletes a task). */
export function setTaskArchived(db: Queryable, id: number, archived: boolean, expectedVersion: number): Promise<TaskWriteOutcome> {
  return casUpdate(
    db,
    id,
    expectedVersion,
    `archived_at = case when $1 then coalesce(archived_at, now()) end`,
    [archived],
    { allowArchived: true },
  );
}

// ---------------------------------------------------------------- read

export async function getTask(db: Queryable, id: number): Promise<TaskDetail | undefined> {
  const { rows } = await db.query<TaskDetail>(`select ${DETAIL_COLUMNS} from tasks t ${JOINS} where t.id = $1`, [id]);
  return rows[0];
}

export const TASK_LIST_LIMIT = 200;

export interface TaskListFilter {
  status: TaskStatusFilter;
  due: TaskDueFilter;
  /** KST day the due filters are relative to */
  today: IsoDate;
  limit?: number;
}

/** One page of the task list (bounded) plus the exact number of tasks matching the filter. */
export async function listTasks(db: Queryable, filter: TaskListFilter): Promise<{ items: TaskListItem[]; total: number }> {
  const params: unknown[] = [];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [filter.status === 'archived' ? 't.archived_at is not null' : 't.archived_at is null'];
  if (filter.status === 'open') where.push(`s.category_key <> 'done'`);
  else if (filter.status !== 'all' && filter.status !== 'archived') where.push(`s.category_key = ${param(filter.status)}`);
  if (filter.due === 'none') where.push(DUE_SQL.none(''));
  else if (filter.due !== 'all') where.push(DUE_SQL[filter.due](param(filter.today)));

  const { rows } = await db.query<TaskListItem & { total: number }>(
    `select ${LIST_COLUMNS}, count(*) over ()::int as total
       from tasks t ${JOINS}
      where ${where.join(' and ')}
      order by ${ORDER}
      limit ${param(filter.limit ?? TASK_LIST_LIMIT)}`,
    params,
  );
  if (rows.length === 0) return { items: [], total: 0 };
  return { items: rows.map(({ total: _total, ...item }) => item), total: rows[0]!.total };
}

export interface ReviewTasks {
  /** the first `limit` linked tasks, open first */
  items: TaskListItem[];
  /** exact number of linked, unarchived tasks */
  total: number;
  /** exact number of those not done */
  open: number;
}

/** Tasks linked to one review (review detail page): not archived, open first; exact counts, bounded list. */
export async function listReviewTasks(db: Queryable, reviewId: number, limit = TASK_LIST_LIMIT): Promise<ReviewTasks> {
  const { rows } = await db.query<TaskListItem & { total: number; open: number }>(
    `select ${LIST_COLUMNS}, count(*) over ()::int as total,
            (count(*) filter (where s.category_key <> 'done') over ())::int as open
       from tasks t ${JOINS}
      where t.review_id = $1 and t.archived_at is null
      order by (s.category_key = 'done'), ${ORDER}
      limit $2`,
    [reviewId, limit],
  );
  if (rows.length === 0) return { items: [], total: 0, open: 0 };
  return { items: rows.map(({ total: _total, open: _open, ...item }) => item), total: rows[0]!.total, open: rows[0]!.open };
}

export interface TaskBucket {
  /** exact number of matching tasks */
  count: number;
  /** the first `limit` of them */
  items: TaskListItem[];
}

/** Dashboard: open, unarchived tasks due today / overdue (KST `today`), exact counts with bounded lists. */
export async function taskDashboard(db: Queryable, today: IsoDate, limit = 8): Promise<{ today: TaskBucket; overdue: TaskBucket }> {
  const bucket = async (due: 'today' | 'overdue'): Promise<TaskBucket> => {
    const { items, total } = await listTasks(db, { status: 'open', due, today, limit });
    return { count: total, items };
  };
  const [dueToday, overdue] = await Promise.all([bucket('today'), bucket('overdue')]);
  return { today: dueToday, overdue };
}

/** Active reviews a task can be linked to (link picker), most recently touched first. */
export async function listLinkableReviews(db: Queryable, limit = 300): Promise<{ id: number; productName: string }[]> {
  const { rows } = await db.query<{ id: number; productName: string }>(
    `select id, product_name as "productName" from reviews where archived_at is null
      order by updated_at desc, id desc limit $1`,
    [limit],
  );
  return rows;
}
