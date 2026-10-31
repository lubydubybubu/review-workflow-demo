import { describe, expect, it } from 'vitest';
import { todayInSeoul } from '../../src/lib/domain/dates';
import {
  parseTaskListParams,
  TASK_DUE_MAX,
  TASK_DUE_MIN,
  taskDueState,
} from '../../src/lib/domain/task';
import { initialTaskEditor, rebaseTaskEditor, TASK_STALE_MESSAGE, toTaskForm, type TaskEditorState } from '../../src/lib/task-form';
import { taskArchiveSchema, taskCreateSchema, taskStatusSchema, taskUpdateSchema } from '../../src/lib/validation';
import type { TaskDetail } from '../../src/server/db/tasks';

const task: TaskDetail = {
  id: 11,
  title: '썸네일 시안 3종',
  status: 'in_progress',
  stageName: '진행 중',
  priority: 'high',
  dueOn: '2026-10-24',
  reviewId: 5,
  reviewName: 'Northwind NX7',
  reviewArchived: false,
  memoMd: '## 메모\n- 색 대비',
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  version: 3,
};

const valid = { title: '자막 검수', priority: 'normal', dueOn: '2026-10-24', reviewId: '', memoMd: '' };

describe('task validation (zod, shared by every task action)', () => {
  it('accepts a minimal task; blanks become null; priority defaults to 보통', () => {
    expect(taskCreateSchema.parse({ title: '  자막 검수 ' })).toEqual({
      title: '자막 검수',
      priority: 'normal',
      dueOn: null,
      reviewId: null,
      memoMd: '',
    });
    expect(taskCreateSchema.parse(valid)).toMatchObject({ dueOn: '2026-10-24', reviewId: null });
  });

  it.each([
    ['NUL', 'a\u0000b'],
    ['newline', 'a\nb'],
    ['tab', 'a\tb'],
    ['escape', 'a\u001bb'],
    ['DEL', 'a\u007fb'],
  ])('title with a control character (%s) is refused', (_, title) => {
    const r = taskCreateSchema.safeParse({ ...valid, title });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['title']);
  });

  it('empty / whitespace / too long titles are refused', () => {
    for (const title of ['', '   ', 'x'.repeat(201)]) expect(taskCreateSchema.safeParse({ ...valid, title }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ ...valid, title: 'x'.repeat(200) }).success).toBe(true);
  });

  it('memo keeps newlines and tabs but refuses NUL and other control characters', () => {
    expect(taskCreateSchema.parse({ ...valid, memoMd: '## a\n\t- b\r\n' }).memoMd).toBe('## a\n\t- b\r\n');
    for (const memoMd of ['a\u0000b', 'a\u0007b', 'a\u007fb']) {
      const r = taskCreateSchema.safeParse({ ...valid, memoMd });
      expect(r.success, JSON.stringify(memoMd)).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['memoMd']);
    }
    expect(taskCreateSchema.safeParse({ ...valid, memoMd: 'x'.repeat(20_001) }).success).toBe(false);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-1-01', '20261024', '2026-10-24T00:00', 'tomorrow', '２０２６-10-24'])(
    'malformed due date %s is refused',
    (dueOn) => {
      const r = taskCreateSchema.safeParse({ ...valid, dueOn });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.path).toEqual(['dueOn']);
    },
  );

  it('due dates outside 2000-01-01 … 2099-12-31 are refused; the bounds themselves are fine', () => {
    expect([TASK_DUE_MIN, TASK_DUE_MAX]).toEqual(['2000-01-01', '2099-12-31']);
    for (const dueOn of ['1999-12-31', '2100-01-01', '9999-12-31', '0001-01-01']) {
      expect(taskCreateSchema.safeParse({ ...valid, dueOn }).success, dueOn).toBe(false);
    }
    for (const dueOn of [TASK_DUE_MIN, TASK_DUE_MAX]) expect(taskCreateSchema.safeParse({ ...valid, dueOn }).success).toBe(true);
  });

  it('status and priority are closed enums; ids are positive integers', () => {
    const base = { ...valid, status: 'todo' };
    expect(taskUpdateSchema.safeParse({ ...base, status: 'blocked' }).success).toBe(false);
    expect(taskUpdateSchema.safeParse({ ...base, priority: 'urgent' }).success).toBe(false);
    expect(taskUpdateSchema.safeParse({ ...base, reviewId: '-3' }).success).toBe(false);
    expect(taskUpdateSchema.safeParse({ ...base, reviewId: '7' }).data?.reviewId).toBe(7);
    expect(taskStatusSchema.safeParse({ id: 1, status: 'done', expectedVersion: 0 }).success).toBe(false);
    expect(taskStatusSchema.safeParse({ id: 1, status: 'done', expectedVersion: 2 }).success).toBe(true);
    expect(taskArchiveSchema.safeParse({ id: 1, archived: 'yes', expectedVersion: 2 }).success).toBe(false);
  });
});

describe('task due state (KST calendar days)', () => {
  it('the KST day boundary is 15:00 UTC (fixed clock)', () => {
    expect(todayInSeoul(new Date('2026-10-23T14:59:59.999Z'))).toBe('2026-10-23');
    expect(todayInSeoul(new Date('2026-10-23T15:00:00.000Z'))).toBe('2026-10-24');
  });

  it('a task due 10-24 is upcoming at 23:59:59 KST on 10-23, due today one ms later, overdue the day after', () => {
    const t = { status: 'todo' as const, dueOn: '2026-10-24' };
    expect(taskDueState(t, todayInSeoul(new Date('2026-10-24T14:59:59.999Z')))).toBe('today');
    expect(taskDueState(t, todayInSeoul(new Date('2026-10-23T14:59:59.999Z')))).toBe('upcoming');
    expect(taskDueState(t, todayInSeoul(new Date('2026-10-24T15:00:00.000Z')))).toBe('overdue');
  });

  it('done tasks are never due or overdue; no date is "none"', () => {
    expect(taskDueState({ status: 'done', dueOn: '2020-01-01' }, '2026-10-24')).toBeNull();
    expect(taskDueState({ status: 'in_progress', dueOn: null }, '2026-10-24')).toBe('none');
  });

  it('list params: unknown / repeated values fall back to the defaults (open, all)', () => {
    expect(parseTaskListParams({})).toEqual({ status: 'open', due: 'all' });
    expect(parseTaskListParams({ status: 'done', due: 'overdue' })).toEqual({ status: 'done', due: 'overdue' });
    expect(parseTaskListParams({ status: 'evil', due: ['today', 'none'] })).toEqual({ status: 'open', due: 'all' });
    expect(parseTaskListParams({ status: 'archived', due: 'none' })).toEqual({ status: 'archived', due: 'none' });
  });
});

describe('task editor draft ↔ version pairing', () => {
  const later: TaskDetail = { ...task, title: '다른 탭에서 바꾼 제목', version: 4 };

  it('the form maps every stored field to strings', () => {
    expect(toTaskForm(task)).toEqual({
      title: '썸네일 시안 3종',
      status: 'in_progress',
      priority: 'high',
      dueOn: '2026-10-24',
      reviewId: '5',
      memoMd: '## 메모\n- 색 대비',
    });
    expect(taskUpdateSchema.parse(toTaskForm(task))).toMatchObject({ reviewId: 5, dueOn: '2026-10-24', status: 'in_progress' });
  });

  it('an untouched editor follows a background refresh (new form AND new version together)', () => {
    const state = initialTaskEditor(task);
    const next = rebaseTaskEditor(state, later);
    expect(next.baseVersion).toBe(4);
    expect(next.form.title).toBe('다른 탭에서 바꾼 제목');
    expect(next.initial).toEqual(next.form);
  });

  it('a background refresh never refreshes the version of an unsaved draft', () => {
    const state: TaskEditorState = { ...initialTaskEditor(task), form: { ...toTaskForm(task), memoMd: '아직 저장 안 한 메모' } };
    const next = rebaseTaskEditor(state, later);
    expect(next).toBe(state);
    expect(next.baseVersion).toBe(3);
    expect(next.form.memoMd).toBe('아직 저장 안 한 메모');
  });

  it('the same version re-rendered is a no-op', () => {
    const state = initialTaskEditor(task);
    expect(rebaseTaskEditor(state, { ...task })).toBe(state);
  });

  it('stale message is Korean and tells the owner what to do', () => {
    expect(TASK_STALE_MESSAGE).toMatch(/다른 곳에서/);
  });
});
