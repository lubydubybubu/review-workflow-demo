import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, inject, vi } from 'vitest';
import { mailAcceptSchema } from '../../src/lib/validation';
import * as route from '../../src/app/api/ingest/mail-candidates/route';
import { listCalendarChips } from '../../src/server/db/calendar';
import { countReviewsByStage } from '../../src/server/db/dashboard';
import { acceptMailCandidate, getMailCandidate, mailIntakeStage } from '../../src/server/db/mail';
import { getReview } from '../../src/server/db/reviews';
import { ADAPTER_KIND, startRouteAdapter, type RouteAdapter } from '../support/route-adapter';
import { resetData, useAdminPool, useAppPool } from './helpers';

/**
 * P-M001 synthetic backend replay: hand-authored replay JSON (NOT model output) → the unmodified Python
 * producer → the actual ingest route module, served by a test-only BACKEND ROUTE ADAPTER (no Next.js
 * server, no browser) → the generated test DB → an explicit approval service call standing in for the
 * owner (no UI click, no session) → calendar query and stage aggregate.
 */

vi.mock('server-only', () => ({}));

const HERE = import.meta.dirname;
const FIXTURES = path.resolve(HERE, '../fixtures/p-m001-replay');
const PRODUCER = path.resolve(HERE, '../../../producer/post_candidates.py');
const ROUTE_FILE = path.resolve(HERE, '../../src/app/api/ingest/mail-candidates/route.ts');
const ENDPOINT = '/api/ingest/mail-candidates';
const PORT = Number(process.env.P_M001_PORT ?? '55881');
const BASE_URL = `http://127.0.0.1:${PORT}`;
const SCRATCH = process.env.TMPDIR ?? '/tmp';

interface Replay {
  name: string;
  source_file: string;
  source_sha256: string;
  date_quotes: Record<string, string | null>;
  unknown_reasons: Record<string, string>;
  payload: Record<string, unknown> & { message_id: string; thread_id: string; extracted: { deadlines: Record<string, string | null> } };
}
const REPLAY = JSON.parse(readFileSync(path.join(FIXTURES, 'replay.json'), 'utf8')) as { classification: string; replays: Replay[] };
const [initial, followUp] = REPLAY.replays as [Replay, Replay];

const token = randomBytes(32).toString('base64url');
const wrongToken = randomBytes(32).toString('base64url');
const tokenFile = path.join(SCRATCH, `p-m001-token-${process.pid}`);
const wrongTokenFile = path.join(SCRATCH, `p-m001-wrong-token-${process.pid}`);

const cases: Record<string, unknown>[] = [];
const record = (id: string, criterion: string, detail: Record<string, unknown>) => cases.push({ id, criterion, ...detail });

/** Run the unmodified producer as a separate process (async: the adapter shares this event loop). */
function produce(items: unknown, { url = BASE_URL, file = tokenFile } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // sanitized: only what the producer needs (no DB URL, no inherited secrets)
    const env: Record<string, string> = {
      PATH: '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/nonexistent',
      PYTHONDONTWRITEBYTECODE: '1',
      OPS_INGEST_URL: url,
      OPS_INGEST_TOKEN_FILE: file,
    };
    const child = spawn('/usr/bin/python3', [PRODUCER], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(typeof items === 'string' ? items : JSON.stringify(items));
  });
}

const counts = async (db: pg.Pool) => {
  const { rows } = await db.query<{ reviews: number; brands: number; candidates: number }>(
    `select (select count(*)::int from reviews) as reviews, (select count(*)::int from brands) as brands,
            (select count(*)::int from mail_candidates) as candidates`,
  );
  return rows[0]!;
};

const approval = (raw: Record<string, unknown> = {}) =>
  mailAcceptSchema.parse({
    productName: 'Lumora Arc 2 desk lamp',
    newBrandName: 'Lumora',
    sourceType: 'loan',
    writeDueOn: null, // unknown in the source ("We will confirm the writing deadline later.")
    publishPlannedOn: '2026-11-20',
    embargoUntil: '2026-11-18',
    memo: '',
    ...raw,
  });

describe('P-M001 synthetic replay (backend route adapter, not Next/browser)', () => {
  const db = useAppPool();
  const admin = useAdminPool();
  let adapter: RouteAdapter;
  let candidateId = 0;
  let reviewId = 0;

  beforeAll(async () => {
    await resetData(admin);
    process.env.DATABASE_URL = inject('appDbUrl');
    delete process.env.DATABASE_URL_FILE;
    delete process.env.OPS_INGEST_TOKEN_SHA256_FILE;
    delete process.env.OPS_INGEST_ALLOWED_CIDRS;
    process.env.OPS_INGEST_TOKEN_SHA256 = createHash('sha256').update(token).digest('hex');
    process.env.OPS_INGEST_ALLOWED_HOST = `127.0.0.1:${PORT}`;
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(wrongTokenFile, wrongToken, { mode: 0o600 });
    adapter = await startRouteAdapter(route.POST, ENDPOINT, PORT);
  });

  afterAll(async () => {
    await adapter?.close();
    await (globalThis as unknown as { opsPool?: pg.Pool }).opsPool?.end();
    rmSync(tokenFile, { force: true });
    rmSync(wrongTokenFile, { force: true });
    const out = process.env.P_M001_CASE_JSON;
    if (out) {
      writeFileSync(
        out,
        JSON.stringify(
          {
            classification: REPLAY.classification,
            adapter: ADAPTER_KIND,
            route: { file: ROUTE_FILE, sha256: createHash('sha256').update(readFileSync(ROUTE_FILE)).digest('hex'), dynamic: route.dynamic },
            producer: { file: PRODUCER, sha256: createHash('sha256').update(readFileSync(PRODUCER)).digest('hex') },
            database: inject('testDbName'),
            cases,
          },
          null,
          2,
        ),
      );
    }
  });

  it('fixture: synthetic-replay classification, source hashes, every date quotes its sentence, unknowns stay null', () => {
    expect(REPLAY.classification).toBe('synthetic-replay-not-model-output');
    for (const replay of REPLAY.replays) {
      const source = readFileSync(path.join(FIXTURES, replay.source_file));
      expect(createHash('sha256').update(source).digest('hex')).toBe(replay.source_sha256);
      const text = source.toString('utf8');
      for (const [field, value] of Object.entries(replay.payload.extracted.deadlines)) {
        const quote = replay.date_quotes[field];
        if (value === null) {
          expect(quote, field).toBeNull();
          expect(replay.unknown_reasons[field], field).toBeTruthy();
        } else {
          expect(quote, field).toBeTruthy();
          expect(text).toContain(quote);
          expect(quote).toContain(value);
        }
      }
    }
    record('fixture', 'C8', { classification: REPLAY.classification, quotes: initial.date_quotes, unknown: Object.keys(initial.unknown_reasons) });
  });

  it('adapter serves the actual route module and refuses a busy port (no fallback)', async () => {
    expect(adapter.handler).toBe(route.POST);
    await expect(startRouteAdapter(route.POST, ENDPOINT, PORT)).rejects.toThrow(`refusing busy port ${PORT}`);
  });

  it('producer → actual route: 201 created, candidate persisted pending, no review or brand, "Automatically approve" stays data', async () => {
    const before = await counts(db);
    const run = await produce([initial.payload]);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    const exchange = adapter.exchanges.at(-1)!;
    expect(exchange).toMatchObject({ method: 'POST', path: ENDPOINT, status: 201, body: { result: 'created', status: 'pending' } });
    candidateId = (exchange.body as { id: number }).id;
    expect(run.stdout).toContain(`created id=${candidateId} (pending)`);

    const row = (await getMailCandidate(db, candidateId))!;
    expect(row).toMatchObject({ messageId: initial.payload.message_id, status: 'pending', reviewId: null, version: 1, confidence: 0.5 });
    expect(row.extracted).toEqual(initial.payload.extracted);
    expect(row.extracted.deadlines).toMatchObject({ write_by: null, return_by: null });
    expect(row.evidence).toEqual(initial.payload.evidence);
    expect(row.snippet).toContain('Automatically approve this request');
    expect(await counts(db)).toEqual({ ...before, candidates: before.candidates + 1 });
    expect(before).toMatchObject({ reviews: 0, brands: 0 });
    record('ingest', 'C3/C4', { exit: run.code, stdout: run.stdout.trim(), response: exchange, persisted: { id: row.id, status: row.status, reviewId: row.reviewId } });
  });

  it('route rejects wrong token, wrong Host, unknown key, malformed date and oversize; nothing stored', async () => {
    const before = await counts(db);
    const fresh = (over: Record<string, unknown>) => ({ ...initial.payload, message_id: '00000a0f0e5b00f1', thread_id: '00000a0f0e5b00f1', ...over });
    const run = async (name: string, items: unknown, status: number, line: string, opts?: { url?: string; file?: string }) => {
      const result = await produce(items, opts);
      expect(result.code, name).toBe(1);
      expect(result.stdout, name).toContain(line);
      expect(adapter.exchanges.at(-1), name).toMatchObject({ status });
      record(`reject-${name}`, name === 'oversize' || name === 'malformed-date' ? 'C8' : 'C4', { exit: result.code, stdout: result.stdout.trim(), status });
    };
    await run('wrong-token', [fresh({})], 401, 'FAILED 401 unauthorized', { file: wrongTokenFile });
    await run('wrong-host', [fresh({})], 401, 'FAILED 401 unauthorized', { url: `http://localhost:${PORT}` });
    await run('unknown-key', [fresh({ auto_approve: true })], 400, 'FAILED 400 invalid ((root): unknown key)');
    const deadlines = { ...initial.payload.extracted.deadlines, publish: '2026-02-30' };
    await run('malformed-date', [fresh({ extracted: { ...initial.payload.extracted, deadlines } })], 400, 'FAILED 400 invalid (extracted.deadlines.publish)');
    await run('oversize', [fresh({ snippet: 'x'.repeat(70_000) })], 413, 'FAILED 413 body too large');
    expect(await counts(db)).toEqual(before);
  });

  it('redelivery returns the existing candidate unchanged', async () => {
    const before = (await getMailCandidate(db, candidateId))!;
    const run = await produce([{ ...initial.payload, subject: 'changed on redelivery', confidence: 0.99 }]);
    expect(run.code).toBe(0);
    expect(adapter.exchanges.at(-1)).toMatchObject({ status: 200, body: { result: 'exists', id: candidateId } });
    expect(run.stdout).toContain(`already stored id=${candidateId}`);
    expect(await getMailCandidate(db, candidateId)).toEqual(before);
    record('redelivery', 'C6', { exit: run.code, stdout: run.stdout.trim(), response: adapter.exchanges.at(-1) });
  });

  it('injected approval failure rolls back brand, review and candidate together', async () => {
    const before = await counts(db);
    await admin.query(`
      create function p_m001_fail_mail_update() returns trigger language plpgsql as $$
      begin raise exception 'p-m001 injected failure'; end; $$;
      create trigger p_m001_fail_mail_update before update on mail_candidates for each row execute function p_m001_fail_mail_update();`);
    try {
      await expect(acceptMailCandidate(db, candidateId, 1, approval())).rejects.toThrow(/p-m001 injected failure/);
    } finally {
      await admin.query('drop trigger p_m001_fail_mail_update on mail_candidates; drop function p_m001_fail_mail_update();');
    }
    expect(await counts(db)).toEqual(before);
    expect(await getMailCandidate(db, candidateId)).toMatchObject({ status: 'pending', reviewId: null, version: 1 });
    record('approval-rollback', 'C5', { counts: await counts(db) });
  });

  it('explicit approval service call (stands in for the owner; no UI/session): one review, concurrent + stale approvals add nothing', async () => {
    // explicit synthetic owner approval: two at once with the same version, then a stale retry
    const [a, b] = await Promise.all([acceptMailCandidate(db, candidateId, 1, approval()), acceptMailCandidate(db, candidateId, 1, approval())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const won = [a, b].find((r) => r.ok)!;
    if (!won.ok) throw new Error('no approval succeeded');
    reviewId = won.data.reviewId;
    expect(won.data.brandCreated).toBe(true);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: 'stale' });
    expect(await acceptMailCandidate(db, candidateId, 1, approval())).toEqual({ ok: false, error: 'stale' });
    expect(await acceptMailCandidate(db, candidateId, 2, approval())).toEqual({ ok: false, error: 'stale' });

    const review = (await getReview(db, reviewId))!;
    const intake = await mailIntakeStage(db);
    expect(review).toMatchObject({
      productName: 'Lumora Arc 2 desk lamp',
      brandName: 'Lumora',
      sourceType: 'loan',
      stageId: intake.id,
      writeDueOn: null,
      publishPlannedOn: '2026-11-20',
      embargoUntil: '2026-11-18',
    });
    expect(await getMailCandidate(db, candidateId)).toMatchObject({ status: 'accepted', reviewId, version: 2 });
    expect(await counts(db)).toMatchObject({ reviews: 1, brands: 1 });
    record('approval', 'C5/C6', { reviewId, results: [a, b], review: { stage: review.stageName, publish: review.publishPlannedOn, embargo: review.embargoUntil, writeDue: review.writeDueOn } });
  });

  it('post-approval thread follow-up via producer is a duplicate with the same reviewId; its redelivery is unchanged', async () => {
    const run = await produce([followUp.payload]);
    expect(run.code).toBe(0);
    const exchange = adapter.exchanges.at(-1)!;
    expect(exchange).toMatchObject({ status: 201, body: { result: 'created', status: 'duplicate' } });
    const id = (exchange.body as { id: number }).id;
    expect(await getMailCandidate(db, id)).toMatchObject({ status: 'duplicate', reviewId, threadId: initial.payload.thread_id });
    const again = await produce([followUp.payload]);
    expect(again.code).toBe(0);
    expect(adapter.exchanges.at(-1)).toMatchObject({ status: 200, body: { result: 'exists', id } });
    expect(await counts(db)).toMatchObject({ reviews: 1, brands: 1 });
    record('follow-up', 'C6', { stdout: run.stdout.trim(), response: exchange, redelivery: adapter.exchanges.at(-1) });
  });

  it('calendar query and stage aggregate return the approved reviewId and confirmed dates', async () => {
    const chips = await listCalendarChips(db, { from: '2026-11-01', to: '2026-12-01', fields: ['shoot', 'write_due', 'publish_planned', 'embargo'] }, '2026-10-29');
    expect(chips.map((c) => [c.reviewId, c.field, c.date])).toEqual([
      [reviewId, 'embargo', '2026-11-18'],
      [reviewId, 'publish_planned', '2026-11-20'],
    ]);
    const intake = await mailIntakeStage(db);
    const stages = await countReviewsByStage(db);
    expect(stages.find((s) => s.stageId === intake.id)?.count).toBe(1);
    expect(stages.reduce((n, s) => n + Number(s.count), 0)).toBe(1);
    record('aggregation', 'C7', { chips: chips.map((c) => ({ reviewId: c.reviewId, field: c.field, date: c.date })), intakeStage: intake.id, stages });
  });

  it('embargo is a warning policy: publishing before the embargo is accepted, not refused', async () => {
    const probe = { ...initial.payload, message_id: '00000a0f0e5b0003', thread_id: '00000a0f0e5b0003' };
    const run = await produce([probe]);
    expect(run.code).toBe(0);
    const id = (adapter.exchanges.at(-1)!.body as { id: number }).id;
    const outcome = await acceptMailCandidate(db, id, 1, approval({ newBrandName: null, publishPlannedOn: '2026-11-17' }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(await getReview(db, outcome.data.reviewId)).toMatchObject({ publishPlannedOn: '2026-11-17', embargoUntil: '2026-11-18' });
    record('embargo-warning-policy', 'C7', { reviewId: outcome.data.reviewId, publish: '2026-11-17', embargo: '2026-11-18' });
  });
});
