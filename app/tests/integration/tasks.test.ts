import type pg from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../src/lib/domain/dates';
import { taskDueState } from '../../src/lib/domain/task';
import { taskCreateSchema, taskUpdateSchema } from '../../src/lib/validation';
import { friendlyDbError } from '../../src/server/db/errors';
import { seedDemo } from '../../src/server/db/seed';
import { createReview, getReview, setReviewArchived, updateReview } from '../../src/server/db/reviews';
import {
  createTask,
  getTask,
  listReviewTasks,
  listTasks,
  setTaskArchived,
  setTaskStatus,
  taskDashboard,
  updateTask,
} from '../../src/server/db/tasks';
import { toReviewForm } from '../../src/lib/review-form';
import { reviewUpdateSchema } from '../../src/lib/validation';
import { pgErrorCode, resetData, useAdminPool, useAppPool } from './helpers';

const TODAY = '2026-10-23';
const newTask = (db: pg.Pool, raw: Record<string, unknown> = {}) => createTask(db, taskCreateSchema.parse({ title: '자막 검수', ...raw }));
const update = (db: pg.Pool, id: number, raw: Record<string, unknown>, version: number) =>
  updateTask(db, id, taskUpdateSchema.parse({ title: '자막 검수', status: 'todo', priority: 'normal', ...raw }), version);

async function review(db: pg.Pool, productName = 'Kestrel K2 키보드') {
  return createReview(db, { productName, templateId: null, stageId: null, brandId: null, sourceType: null, anchorField: null, anchorDate: null });
}

describe('tasks: schema (009-tasks.sql)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('task stages are fixed per category with entity_type task, and are not review stages', async () => {
    const { rows } = await db.query<{ category_key: string; is_default: boolean }>(
      `select category_key, is_default from workflow_stages where entity_type = 'task' order by sort, category_key`,
    );
    expect(rows.map((r) => r.category_key).sort()).toEqual(['done', 'in_progress', 'todo']);
    expect(rows.filter((r) => r.is_default).map((r) => r.category_key)).toEqual(['todo']);
    const reviewStages = await db.query(`select count(*)::int as n from workflow_stages where entity_type = 'review'`);
    expect(reviewStages.rows[0].n).toBe(7);
  });

  it('the database refuses a task pinned to a review stage (composite FK on entity type)', async () => {
    const reviewStage = (await db.query<{ id: number }>(`select id from workflow_stages where entity_type = 'review' limit 1`)).rows[0]!.id;
    await expect(db.query(`insert into tasks (title, stage_id) values ('x', $1)`, [reviewStage])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23503',
    );
    await expect(
      db.query(`insert into tasks (title, stage_id, stage_entity) values ('x', $1, 'review')`, [reviewStage]),
    ).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    // and a review can never point at a task stage
    const taskStage = (await db.query<{ id: number }>(`select id from workflow_stages where entity_type = 'task' limit 1`)).rows[0]!.id;
    const r = await review(db);
    await expect(db.query('update reviews set stage_id = $2 where id = $1', [r, taskStage])).rejects.toSatisfy(
      (e) => pgErrorCode(e) === '23503',
    );
  });

  it('DB checks back the zod rules: control characters, empty title, due date range', async () => {
    const stage = (await db.query<{ id: number }>(`select id from workflow_stages where entity_type = 'task' and is_default`)).rows[0]!.id;
    const bad = [
      [`insert into tasks (title, stage_id) values (E'a\\x01b', $1)`],
      [`insert into tasks (title, stage_id) values (E'a\\nb', $1)`],
      [`insert into tasks (title, stage_id) values ('  ', $1)`],
      [`insert into tasks (title, stage_id, memo_md) values ('ok', $1, E'a\\x07b')`],
      [`insert into tasks (title, stage_id, due_on) values ('ok', $1, '1999-12-31')`],
      [`insert into tasks (title, stage_id, due_on) values ('ok', $1, '2100-01-01')`],
    ];
    for (const [sql] of bad) await expect(db.query(sql!, [stage]), sql).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    // PostgreSQL text cannot hold NUL at all
    await expect(db.query(`insert into tasks (title, stage_id) values ($1, $2)`, ['a\u0000b', stage])).rejects.toThrow();
    const ok = await db.query(`insert into tasks (title, stage_id, memo_md) values ('ok', $1, E'줄1\\n\\t줄2\\r\\n') returning id`, [stage]);
    expect(ok.rowCount).toBe(1);
  });

  it('runtime role: DML on tasks, no DDL, no DELETE needed by the app (soft archive only)', async () => {
    await expect(db.query('alter table tasks add column x int')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    await expect(db.query('drop table tasks')).rejects.toSatisfy((e) => pgErrorCode(e) === '42501');
    const { rows } = await db.query<{ rolsuper: boolean }>('select rolsuper from pg_roles where rolname = current_user');
    expect(rows[0]!.rolsuper).toBe(false);
  });
});

describe('tasks: data layer', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('create → read: todo, version 1, linked review name; status follows the task stage category', async () => {
    const r = await review(db);
    const id = await newTask(db, { reviewId: r, dueOn: '2026-10-24', priority: 'high', memoMd: '## 메모' });
    const t = (await getTask(db, id))!;
    expect(t).toMatchObject({
      title: '자막 검수',
      status: 'todo',
      stageName: '할 일',
      priority: 'high',
      dueOn: '2026-10-24',
      reviewId: r,
      reviewName: 'Kestrel K2 키보드',
      reviewArchived: false,
      memoMd: '## 메모',
      completedAt: null,
      archivedAt: null,
      version: 1,
    });
  });

  it('every writer is compare-and-set on version; a stale write changes nothing', async () => {
    const id = await newTask(db);
    const first = await update(db, id, { title: '첫 수정', memoMd: '탭 A 메모' }, 1);
    expect(first).toMatchObject({ ok: true, task: { title: '첫 수정', version: 2 } });
    // a second tab still holding version 1:
    expect(await update(db, id, { title: '덮어쓰기 시도' }, 1)).toEqual({ ok: false, error: 'stale' });
    expect(await setTaskStatus(db, id, 'done', 1)).toEqual({ ok: false, error: 'stale' });
    expect(await setTaskArchived(db, id, true, 1)).toEqual({ ok: false, error: 'stale' });
    expect(await getTask(db, id)).toMatchObject({ title: '첫 수정', memoMd: '탭 A 메모', status: 'todo', archivedAt: null, version: 2 });
  });

  it('simultaneous saves with the same version: exactly one wins, the other is stale', async () => {
    const id = await newTask(db);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) => update(db, id, { title: `동시 저장 ${i}` }, 1)),
    );
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.error === 'stale')).toHaveLength(5);
    expect((await getTask(db, id))!.version).toBe(2);
  });

  it('complete / reopen: completed_at set and cleared by the database; memo and review untouched', async () => {
    const r = await review(db);
    const before = (await getReview(db, r))!;
    const id = await newTask(db, { reviewId: r, memoMd: '지우면 안 되는 메모' });
    const done = await setTaskStatus(db, id, 'done', 1);
    expect(done).toMatchObject({ ok: true, task: { status: 'done', memoMd: '지우면 안 되는 메모', version: 2 } });
    if (!done.ok) return;
    expect(done.task.completedAt).not.toBeNull();
    const reopened = await setTaskStatus(db, id, 'todo', 2);
    expect(reopened).toMatchObject({ ok: true, task: { status: 'todo', completedAt: null, memoMd: '지우면 안 되는 메모', version: 3 } });
    // the parent review did not move, and neither its notes nor its version changed
    const after = (await getReview(db, r))!;
    expect(after).toMatchObject({ stageId: before.stageId, notesMd: before.notesMd, version: before.version, updatedAt: before.updatedAt });
  });

  it('a linked task write never bumps the review version, so an open review draft stays saveable', async () => {
    const r = await review(db);
    const loaded = (await getReview(db, r))!;
    const id = await newTask(db, { reviewId: r });
    await update(db, id, { title: '바뀐 제목', reviewId: String(r) }, 1);
    await setTaskStatus(db, id, 'done', 2);
    const draft = reviewUpdateSchema.parse({ ...toReviewForm(loaded), notesMd: '리뷰 초안 메모' });
    const saved = await updateReview(db, r, draft, new Date(), loaded.version);
    expect(saved).toMatchObject({ ok: true, review: { notesMd: '리뷰 초안 메모' } });
  });

  it('archived review: no new link (create or relink), existing linked task kept and labelled, still editable', async () => {
    const r = await review(db);
    const other = await review(db, 'Lumen L1 웹캠');
    const kept = await newTask(db, { reviewId: r, memoMd: '보존할 메모' });
    expect(await setReviewArchived(db, r, true)).toBe(true);

    // create linked to the archived review → refused with a Korean message
    const refused = await newTask(db, { reviewId: r }).catch((e: unknown) => e);
    expect(pgErrorCode(refused)).toBe('23514');
    expect(friendlyDbError(refused)).toBe('보관된 리뷰에는 할 일을 새로 연결할 수 없습니다.');

    // the existing task is still there, labelled archived, and can be edited/completed in place
    expect(await getTask(db, kept)).toMatchObject({ reviewId: r, reviewArchived: true, memoMd: '보존할 메모' });
    const edited = await update(db, kept, { title: '계속 진행', reviewId: String(r), memoMd: '보존할 메모 + 추가' }, 1);
    expect(edited).toMatchObject({ ok: true, task: { reviewId: r, reviewArchived: true } });
    expect(await setTaskStatus(db, kept, 'done', 2)).toMatchObject({ ok: true });

    // relinking another task to it is refused; unlinking or linking to an active review is fine
    const loose = await newTask(db, { reviewId: other });
    await expect(update(db, loose, { reviewId: String(r) }, 1)).rejects.toSatisfy((e) => pgErrorCode(e) === '23514');
    expect(await update(db, loose, { reviewId: '' }, 1)).toMatchObject({ ok: true, task: { reviewId: null } });

    // review archive did not cascade anything to its tasks
    expect((await listReviewTasks(db, r)).items.map((t) => t.id)).toEqual([kept]);
    // and the archived review can be restored with its task
    await setReviewArchived(db, r, false);
    expect(await getTask(db, kept)).toMatchObject({ reviewArchived: false });
  });

  it('review tasks: exact total/open counts even when the list is capped, open first, archived excluded', async () => {
    const r = await review(db);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await newTask(db, { reviewId: r, title: `연결 ${i}` }));
    await setTaskStatus(db, ids[0]!, 'done', 1);
    await setTaskStatus(db, ids[1]!, 'done', 1);
    await setTaskArchived(db, ids[2]!, true, 1);
    await newTask(db, { title: '다른 할 일' });
    const capped = await listReviewTasks(db, r, 1);
    expect(capped).toMatchObject({ total: 4, open: 2 });
    expect(capped.items).toHaveLength(1);
    expect(capped.items[0]!.status).not.toBe('done');
    const all = await listReviewTasks(db, r);
    expect(all).toMatchObject({ total: 4, open: 2 });
    expect(all.items.map((t) => t.status)).toEqual(['todo', 'todo', 'done', 'done']);
    expect(await listReviewTasks(db, await review(db, '빈 리뷰'))).toEqual({ items: [], total: 0, open: 0 });
  });

  it('a nonexistent review id is a foreign-key error, not a silent unlink', async () => {
    await expect(newTask(db, { reviewId: 999_999 })).rejects.toSatisfy((e) => pgErrorCode(e) === '23503');
  });

  it('soft archive: archived tasks leave every list but the archive; edits/status refused until restored; no delete', async () => {
    const id = await newTask(db, { dueOn: TODAY });
    const archived = await setTaskArchived(db, id, true, 1);
    expect(archived).toMatchObject({ ok: true, task: { version: 2 } });
    expect(await update(db, id, { title: 'x' }, 2)).toEqual({ ok: false, error: 'archived' });
    expect(await setTaskStatus(db, id, 'done', 2)).toEqual({ ok: false, error: 'archived' });
    expect((await listTasks(db, { status: 'all', due: 'all', today: TODAY })).total).toBe(0);
    expect((await listTasks(db, { status: 'archived', due: 'all', today: TODAY })).items.map((t) => t.id)).toEqual([id]);
    const restored = await setTaskArchived(db, id, false, 2);
    expect(restored).toMatchObject({ ok: true, task: { archivedAt: null, version: 3 } });
    expect((await db.query('select count(*)::int as n from tasks')).rows[0].n).toBe(1);
  });

  it('unknown task id: not found (thrown), not stale', async () => {
    await expect(update(db, 424242, {}, 1)).rejects.toThrow(/not found/);
    await expect(setTaskStatus(db, 424242, 'done', 1)).rejects.toThrow(/not found/);
  });

  it('list filters: status (open default) × due (today / overdue / none / upcoming) with exact totals', async () => {
    const mk = async (title: string, dueOn: string | null, status?: 'in_progress' | 'done') => {
      const id = await newTask(db, { title, dueOn });
      if (status) await setTaskStatus(db, id, status, 1);
      return id;
    };
    const overdue = await mk('지난 일', addDays(TODAY, -2));
    const today = await mk('오늘 일', TODAY, 'in_progress');
    const upcoming = await mk('다음 주 일', addDays(TODAY, 7));
    const none = await mk('날짜 없음', null);
    const doneLate = await mk('끝난 지난 일', addDays(TODAY, -5), 'done');
    const ids = async (status: string, due: string) =>
      (await listTasks(db, { status: status as never, due: due as never, today: TODAY })).items.map((t) => t.id).sort((a, b) => a - b);

    expect(await ids('open', 'all')).toEqual([overdue, today, upcoming, none].sort((a, b) => a - b));
    expect(await ids('open', 'today')).toEqual([today]);
    expect(await ids('open', 'overdue')).toEqual([overdue]);
    expect(await ids('all', 'overdue')).toEqual([overdue]); // a done task is never overdue
    expect(await ids('open', 'none')).toEqual([none]);
    expect(await ids('open', 'upcoming')).toEqual([upcoming]);
    expect(await ids('done', 'all')).toEqual([doneLate]);
    expect(await ids('in_progress', 'all')).toEqual([today]);
    expect(await ids('todo', 'all')).toEqual([overdue, upcoming, none].sort((a, b) => a - b));
    const bounded = await listTasks(db, { status: 'all', due: 'all', today: TODAY, limit: 2 });
    expect([bounded.items.length, bounded.total]).toEqual([2, 5]);
  });

  it('the SQL due filters agree with taskDueState for every status × due combination', async () => {
    for (const offset of [-30, -1, 0, 1, 30, null]) {
      for (const status of ['todo', 'in_progress', 'done'] as const) {
        const id = await newTask(db, { title: `${status} ${offset}`, dueOn: offset === null ? null : addDays(TODAY, offset) });
        if (status !== 'todo') await setTaskStatus(db, id, status, 1);
      }
    }
    const all = (await listTasks(db, { status: 'all', due: 'all', today: TODAY })).items;
    expect(all).toHaveLength(18);
    for (const due of ['today', 'overdue', 'upcoming', 'none'] as const) {
      const sql = (await listTasks(db, { status: 'all', due, today: TODAY })).items.map((t) => t.id).sort((a, b) => a - b);
      const ts = all
        .filter((t) => (due === 'none' ? t.dueOn === null : taskDueState(t, TODAY) === due))
        .map((t) => t.id)
        .sort((a, b) => a - b);
      expect(sql, due).toEqual(ts);
    }
  });

  it('list order: overdue/earliest due first, no-date last, then priority', async () => {
    const a = await newTask(db, { title: 'a', dueOn: null, priority: 'high' });
    const b = await newTask(db, { title: 'b', dueOn: addDays(TODAY, 3) });
    const c = await newTask(db, { title: 'c', dueOn: addDays(TODAY, -1) });
    const d = await newTask(db, { title: 'd', dueOn: addDays(TODAY, 3), priority: 'high' });
    const { items } = await listTasks(db, { status: 'open', due: 'all', today: TODAY });
    expect(items.map((t) => t.id)).toEqual([c, d, b, a]);
  });
});

describe('tasks: dashboard (KST day, exact counts, bounded lists)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  beforeEach(() => resetData(admin));

  it('today / overdue exclude done and archived; counts are exact while lists are bounded', async () => {
    for (let i = 0; i < 12; i++) await newTask(db, { title: `오늘 ${i}`, dueOn: TODAY });
    for (let i = 0; i < 3; i++) await newTask(db, { title: `지연 ${i}`, dueOn: addDays(TODAY, -1 - i) });
    const doneToday = await newTask(db, { title: '오늘 끝남', dueOn: TODAY });
    await setTaskStatus(db, doneToday, 'done', 1);
    const archivedLate = await newTask(db, { title: '보관된 지연', dueOn: addDays(TODAY, -3) });
    await setTaskArchived(db, archivedLate, true, 1);
    await newTask(db, { title: '내일', dueOn: addDays(TODAY, 1) });

    const dash = await taskDashboard(db, TODAY, 8);
    expect(dash.today.count).toBe(12);
    expect(dash.today.items).toHaveLength(8);
    expect(dash.overdue.count).toBe(3);
    expect(dash.overdue.items.map((t) => t.title)).toEqual(['지연 2', '지연 1', '지연 0']);
    const all = [...dash.today.items, ...dash.overdue.items].map((t) => t.title);
    expect(all).not.toContain('오늘 끝남');
    expect(all).not.toContain('보관된 지연');
  });

  it('demo seed (synthetic): tasks due today / overdue / later / none, one done, one archived, as the runtime role', async () => {
    const seeded = await seedDemo(db, TODAY);
    expect(seeded.tasks).toBe(8);
    const dash = await taskDashboard(db, TODAY, 8);
    expect([dash.today.count, dash.overdue.count]).toEqual([2, 2]);
    expect((await listTasks(db, { status: 'archived', due: 'all', today: TODAY })).total).toBe(1);
    expect((await listTasks(db, { status: 'done', due: 'all', today: TODAY })).total).toBe(1);
  });

  it('fixed clock across the KST midnight: the same row is today, then overdue', async () => {
    await newTask(db, { title: '경계', dueOn: '2026-10-23' });
    const before = await taskDashboard(db, '2026-10-23', 8); // 2026-10-23T14:59:59Z = 23:59:59 KST
    const after = await taskDashboard(db, '2026-10-24', 8); // 2026-10-23T15:00:00Z = 00:00 KST next day
    expect([before.today.count, before.overdue.count]).toEqual([1, 0]);
    expect([after.today.count, after.overdue.count]).toEqual([0, 1]);
  });
});
