/**
 * Task server actions through the real server path: `runAction` → origin check (isTrustedMutation) →
 * DB-backed session check (requireSession → resolveSession → auth_sessions) → zod → data layer, as the
 * DML-only runtime role. Only the Next.js request context is replaced: `next/headers` (the request's
 * Origin / Sec-Fetch-Site and cookie), `next/navigation` redirect (throws like Next does) and
 * `next/cache` revalidation (no render cache here).
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import * as actions from '../../src/server/actions/tasks';
import { tokenHash } from '../../src/server/auth/handoff';
import { createSession } from '../../src/server/auth/store';
import { createPool } from '../../src/server/db/client';
import { createReview, getReview, setReviewArchived } from '../../src/server/db/reviews';
import { getTask } from '../../src/server/db/tasks';
import { resetData, useAdminPool } from './helpers';

const request = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookies: new Map<string, string>(),
  revalidated: [] as string[],
}));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => request.headers.get(name.toLowerCase()) ?? null }),
  cookies: async () => ({ get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined) }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (p: string) => {
    request.revalidated.push(p);
  },
}));

const ORIGIN = 'http://127.0.0.1:3999';
const SAVED_ENV = { ...process.env };

describe('task actions: auth, origin and validation on the real server path', () => {
  const admin = useAdminPool();
  let db: pg.Pool;
  let token: string;

  beforeAll(() => {
    Object.assign(process.env, {
      OPS_AUTH_MODE: 'demo-password',
      OPS_PUBLIC_ORIGIN: ORIGIN,
      OPS_PASSWORD_HASH: 'scrypt:unused-in-these-tests',
    });
    delete process.env.OPS_DEPLOYMENT;
    db = createPool(inject('appDbUrl'));
    (globalThis as { opsPool?: pg.Pool }).opsPool = db;
  });
  afterAll(async () => {
    delete (globalThis as { opsPool?: pg.Pool }).opsPool;
    delete (globalThis as { opsAuthConfig?: unknown }).opsAuthConfig;
    for (const k of ['OPS_AUTH_MODE', 'OPS_PUBLIC_ORIGIN', 'OPS_PASSWORD_HASH']) {
      if (SAVED_ENV[k] === undefined) delete process.env[k];
      else process.env[k] = SAVED_ENV[k];
    }
    await db.end();
  });

  beforeEach(async () => {
    await resetData(admin);
    await admin.query('truncate auth_sessions');
    token = randomBytes(32).toString('base64url');
    await createSession(db, { tokenHash: tokenHash(token), mode: 'demo-password', subject: 'demo', siteGrant: null, expiresAt: new Date(Date.now() + 3_600_000) });
    request.headers = new Map([['origin', ORIGIN]]);
    request.cookies = new Map([['ops_session', token]]);
    request.revalidated = [];
  });

  const count = async () => Number((await db.query('select count(*)::int as n from tasks')).rows[0].n);
  const reviewId = () =>
    createReview(db, { productName: 'Pebble 키캡', templateId: null, stageId: null, brandId: null, sourceType: null, anchorField: null, anchorDate: null });

  it('a trusted, signed-in create succeeds and refreshes /tasks, the dashboard and the linked review', async () => {
    const r = await reviewId();
    const result = await actions.createTaskAction({ title: '썸네일 시안', dueOn: '2026-10-24', reviewId: String(r) });
    expect(result).toMatchObject({ ok: true });
    expect(await count()).toBe(1);
    expect(request.revalidated).toEqual(expect.arrayContaining(['/tasks', '/', `/reviews/${r}`]));
  });

  it.each([
    ['cross-origin Origin', [['origin', 'https://evil.example']]],
    ['sibling-site Origin', [['origin', 'http://127.0.0.1:4000']]],
    ['no Origin, cross-site fetch metadata', [['sec-fetch-site', 'cross-site']]],
    ['no Origin and no fetch metadata', []],
  ] as const)('refused before anything is written: %s', async (_, headers) => {
    request.headers = new Map(headers as unknown as [string, string][]);
    const result = await actions.createTaskAction({ title: '공격' });
    expect(result).toEqual({ ok: false, error: '요청 출처를 확인할 수 없습니다.' });
    expect(await count()).toBe(0);
  });

  it('same-origin fetch metadata without Origin is accepted (same rule as every other action)', async () => {
    request.headers = new Map([['sec-fetch-site', 'same-origin']]);
    expect(await actions.createTaskAction({ title: '같은 출처' })).toMatchObject({ ok: true });
  });

  it('no session / unknown / revoked session → redirected to /login, nothing written', async () => {
    request.cookies = new Map();
    await expect(actions.createTaskAction({ title: '세션 없음' })).rejects.toThrow('NEXT_REDIRECT /login');
    request.cookies = new Map([['ops_session', randomBytes(32).toString('base64url')]]);
    await expect(actions.createTaskAction({ title: '모르는 세션' })).rejects.toThrow('NEXT_REDIRECT /login');
    await admin.query('update auth_sessions set revoked_at = now()');
    request.cookies = new Map([['ops_session', token]]);
    await expect(actions.createTaskAction({ title: '끝난 세션' })).rejects.toThrow('NEXT_REDIRECT /login');
    expect(await count()).toBe(0);
  });

  it('every task writer is behind the same checks (update / status / archive)', async () => {
    const created = await actions.createTaskAction({ title: '원본' });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    request.headers = new Map([['origin', 'https://evil.example']]);
    const form = { title: '변조', status: 'todo', priority: 'normal', dueOn: '', reviewId: '', memoMd: '' };
    expect(await actions.updateTaskAction(id, form, 1)).toMatchObject({ ok: false });
    expect(await actions.setTaskStatusAction({ id, status: 'done', expectedVersion: 1 })).toMatchObject({ ok: false });
    expect(await actions.setTaskArchivedAction({ id, archived: true, expectedVersion: 1 })).toMatchObject({ ok: false });
    expect(await getTask(db, id)).toMatchObject({ title: '원본', status: 'todo', archivedAt: null, version: 1 });
  });

  it('malformed input comes back as field errors in Korean (NUL, control chars, bad / out-of-range dates)', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ title: 'a\u0000b' }, 'title'],
      [{ title: 'ok', memoMd: 'x\u0000y' }, 'memoMd'],
      [{ title: 'ok', dueOn: '2026-02-30' }, 'dueOn'],
      [{ title: 'ok', dueOn: '9999-12-31' }, 'dueOn'],
      [{ title: 'ok', dueOn: "2026-10-24'; drop table tasks; --" }, 'dueOn'],
      [{ title: 'ok', reviewId: '1 or 1=1' }, 'reviewId'],
    ];
    for (const [raw, field] of cases) {
      const result = await actions.createTaskAction(raw);
      expect(result.ok, JSON.stringify(raw)).toBe(false);
      if (!result.ok) {
        expect(Object.keys(result.fieldErrors ?? {})).toContain(field);
        expect(result.error).toMatch(/[가-힣]/);
      }
    }
    expect(await count()).toBe(0);
  });

  it('stale update / complete are refused with the Korean stale message; the newer save survives', async () => {
    const created = await actions.createTaskAction({ title: '원본', memoMd: '메모' });
    if (!created.ok) throw new Error(created.error);
    const id = created.data.id;
    const form = { title: '탭 A', status: 'todo', priority: 'normal', dueOn: '', reviewId: '', memoMd: '탭 A 메모' };
    expect(await actions.updateTaskAction(id, form, 1)).toMatchObject({ ok: true, data: { task: { version: 2 } } });
    const stale = await actions.updateTaskAction(id, { ...form, title: '탭 B', memoMd: '' }, 1);
    expect(stale).toEqual({ ok: false, error: '다른 곳에서 수정되었습니다. 새로고침 후 다시 시도하세요.' });
    expect(await actions.setTaskStatusAction({ id, status: 'done', expectedVersion: 1 })).toMatchObject({ ok: false });
    expect(await getTask(db, id)).toMatchObject({ title: '탭 A', memoMd: '탭 A 메모', status: 'todo' });
  });

  it('an archived review cannot get a new task through the action (Korean message); the review is not touched', async () => {
    const r = await reviewId();
    await setReviewArchived(db, r, true);
    const before = await getReview(db, r);
    const result = await actions.createTaskAction({ title: '연결 시도', reviewId: String(r) });
    expect(result).toEqual({ ok: false, error: '보관된 리뷰에는 할 일을 새로 연결할 수 없습니다.' });
    expect(await count()).toBe(0);
    expect(await getReview(db, r)).toEqual(before);
  });

  it('complete through the action leaves the parent review stage, notes and version alone', async () => {
    const r = await reviewId();
    await db.query(`update reviews set notes_md = '리뷰 메모' where id = $1`, [r]);
    const before = (await getReview(db, r))!;
    const created = await actions.createTaskAction({ title: '체크', reviewId: String(r), memoMd: '할 일 메모' });
    if (!created.ok) throw new Error(created.error);
    const done = await actions.setTaskStatusAction({ id: created.data.id, status: 'done', expectedVersion: 1 });
    expect(done).toMatchObject({ ok: true, data: { task: { status: 'done', memoMd: '할 일 메모' } } });
    expect(await getReview(db, r)).toEqual(before);
  });
});
