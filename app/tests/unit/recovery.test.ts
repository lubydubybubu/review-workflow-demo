import { beforeEach, describe, expect, it } from 'vitest';
import { carriedCount, carriedForm, readRecovery, RECOVERY_KEY, validPrefill, writeRecovery } from '../../src/lib/recovery';
import { UnsavedRegistry, type RecoveryEntry, type UnsavedOwner } from '../../src/lib/unsaved';

/** An in-memory sessionStorage; `failWrites` makes setItem throw like a full quota. */
function fakeStore() {
  const map = new Map<string, string>();
  const store = {
    failWrites: false,
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (store.failWrites) throw new DOMException('full', 'QuotaExceededError');
      map.set(k, v);
    },
    removeItem: (k: string) => void map.delete(k),
  };
  return store;
}

const restored: unknown[] = [];
function owner(fields: Partial<UnsavedOwner> & Pick<UnsavedOwner, 'label'>): UnsavedOwner {
  return { scope: 'route', dirty: false, discard: () => {}, ...fields };
}
const entry = (key: string, extra: Partial<RecoveryEntry> = {}): RecoveryEntry => ({ key, label: key, href: '/x', data: { v: key }, ...extra });

beforeEach(() => {
  writeRecovery(null, 'reset', []); // clears the module's memory copy
  restored.length = 0;
});

describe('registry: a page dialog asks about its own input (confirm)', () => {
  it('clean proceeds; dirty asks once; 계속 편집 keeps it; 버리고 discards exactly it, then proceeds', () => {
    const r = new UnsavedRegistry();
    const log: string[] = [];
    expect(r.confirm([], '닫기', () => log.push('closed'))).toBe('proceeded');
    let q = 'typed';
    const blocker = { label: '기존 리뷰에 연결 (검색어)', discard: () => (q = '') };
    expect(r.confirm([blocker], '닫기', () => log.push('closed again'))).toBe('asked');
    expect(r.pending?.kind).toBe('dismiss');
    expect(r.pending?.action).toBe('닫기');
    expect(r.request('route', '이동', () => log.push('route'))).toBe('busy');
    r.cancel();
    expect([q, log]).toEqual(['typed', ['closed']]);
    r.confirm([blocker], '닫기', () => log.push(`closed after discard: ${q || 'empty'}`));
    r.accept();
    expect(log).toEqual(['closed', 'closed after discard: empty']);
  });

  it('a page-dialog owner (scope route, no kept draft) also holds a page change', () => {
    const r = new UnsavedRegistry();
    r.register(() => owner({ label: '새 할 일', dirty: true }));
    expect(r.request('route', '이동', () => {})).toBe('asked');
    expect(r.pending?.blockers.map((b) => b.label)).toEqual(['새 할 일']);
  });
});

describe('registry: carrying unsaved input across a sign-in', () => {
  it('recoverable = dirty owners with data + kept drafts + unsettled offers; owners win over kept copies; no functions', () => {
    const r = new UnsavedRegistry();
    r.offer([entry('old-offer')]);
    r.keep({ key: 'review-workflow:draft:review:1', label: '리뷰 편집', href: '/reviews/1', draft: { kept: true }, persisted: true });
    r.keep({ key: 'review-workflow:draft:task:2', label: '할 일 편집', href: '/tasks/2', draft: { kept: 'memory' }, persisted: false });
    const restore = (d: unknown) => void restored.push(d);
    r.register(() =>
      owner({ label: '리뷰 편집', dirty: true, keepKey: 'review-workflow:draft:review:1', recovery: { key: 'review-workflow:draft:review:1', href: '/reviews/1', data: { newest: true }, restore } }),
    );
    r.register(() => owner({ label: '‘대여 리뷰’ 템플릿', recovery: { key: 'template:1', href: '/settings', data: undefined, restore } }));
    r.register(() => owner({ label: '새 리뷰', scope: 'overlay', dirty: true, recovery: { key: 'quick-create', href: '/board', open: { kind: 'create', prefill: {} }, data: { form: 1 }, restore } }));
    const got = r.recoverable();
    expect(got.map((e) => e.key).sort()).toEqual(['old-offer', 'quick-create', 'review-workflow:draft:review:1', 'review-workflow:draft:task:2']);
    expect(got.find((e) => e.key === 'review-workflow:draft:review:1')?.data).toEqual({ newest: true });
    expect(got.find((e) => e.key === 'quick-create')).toEqual({ key: 'quick-create', label: '새 리뷰', href: '/board', open: { kind: 'create', prefill: {} }, data: { form: 1 } });
    expect(JSON.parse(JSON.stringify(got))).toEqual(got); // storable as is
  });

  it('offer → 복원 (waits for its owner, taken once) / 버리기; carried keys are not restored on their own', () => {
    const r = new UnsavedRegistry();
    r.offer([entry('a'), entry('b'), entry('a')]);
    expect(r.offers.map((e) => e.key)).toEqual(['a', 'b']);
    expect([r.isCarried('a'), r.isCarried('zzz')]).toEqual([true, false]);
    expect(r.take('a')).toBeUndefined(); // not chosen yet
    expect(r.startRestore('a')?.key).toBe('a');
    expect(r.offers.map((e) => e.key)).toEqual(['b']);
    expect(r.pendingRecovery().map((e) => e.key).sort()).toEqual(['a', 'b']); // still stored until taken
    expect(r.startRestore('a')?.key).toBe('a'); // again (its form was not reached): still waiting
    expect(r.isCarried('a')).toBe(true);
    expect(r.take('a')).toEqual({ v: 'a' });
    expect(r.take('a')).toBeUndefined();
    expect(r.isCarried('a')).toBe(false);
    r.dropCarried('b');
    expect([r.pendingRecovery(), r.isCarried('b'), r.startRestore('b')]).toEqual([[], false, undefined]);
  });

  it('subscribers hear about offers, restores and drops (the shell keeps storage in step)', () => {
    const r = new UnsavedRegistry();
    let n = 0;
    r.subscribe(() => n++);
    r.offer([entry('a'), entry('b')]);
    r.startRestore('a');
    r.take('a');
    r.dropCarried('b');
    r.dropCarried('b'); // nothing left: no news
    expect(n).toBe(4);
  });
});

describe('sessionStorage copy (writeRecovery / readRecovery)', () => {
  it('round trip for the same owner; settled (none left) removes it', () => {
    const s = fakeStore();
    expect(writeRecovery(s, 'owner-a', [entry('k1'), entry('k2', { open: { kind: 'peek', id: 7 } })])).toBe(true);
    expect(s.map.has(RECOVERY_KEY)).toBe(true);
    writeRecovery(null, 'reset', []); // a new page: memory gone, storage remains
    expect(readRecovery(s, 'owner-a').map((e) => e.key)).toEqual(['k1', 'k2']);
    expect(carriedCount(s)).toBe(2);
    expect(writeRecovery(s, 'owner-a', [])).toBe(true);
    expect([s.map.has(RECOVERY_KEY), carriedCount(s)]).toEqual([false, 0]);
  });

  it('another owner signing in is offered nothing, and the copy is removed', () => {
    const s = fakeStore();
    writeRecovery(s, 'owner-a', [entry('k1')]);
    writeRecovery(null, 'reset', []);
    s.map.set(RECOVERY_KEY, JSON.stringify({ v: 1, owner: 'owner-a', entries: [entry('k1')] }));
    expect(readRecovery(s, 'owner-b')).toEqual([]);
    expect(s.map.has(RECOVERY_KEY)).toBe(false);
  });

  it('malformed / foreign values are dropped: bad JSON, wrong version, off-site hrefs, missing data, bad open', () => {
    const s = fakeStore();
    s.map.set(RECOVERY_KEY, '{not json');
    expect(readRecovery(s, 'o')).toEqual([]);
    expect(s.map.has(RECOVERY_KEY)).toBe(false);
    s.map.set(RECOVERY_KEY, JSON.stringify({ v: 2, owner: 'o', entries: [entry('k')] }));
    expect(readRecovery(s, 'o')).toEqual([]);
    const bad = [
      entry('ext', { href: 'https://evil.example/' }),
      entry('proto', { href: '//evil.example/' }),
      entry('bs', { href: '/\\evil.example' }),
      { key: 'nodata', label: 'x', href: '/x' },
      entry('peek0', { open: { kind: 'peek', id: 0 } }),
      entry('badcreate', { open: { kind: 'create', prefill: { mail: { candidateId: 1, version: 'x' } } } }),
      entry('', {}),
    ];
    s.map.set(RECOVERY_KEY, JSON.stringify({ v: 1, owner: 'o', entries: [...bad, entry('good')] }));
    expect(readRecovery(s, 'o').map((e) => e.key)).toEqual(['good']);
  });

  it('a failed write (quota) reports false and leaves no older copy behind; memory still carries them', () => {
    const s = fakeStore();
    writeRecovery(s, 'o', [entry('old')]);
    s.failWrites = true;
    expect(writeRecovery(s, 'o', [entry('new')])).toBe(false);
    expect(s.map.has(RECOVERY_KEY)).toBe(false);
    // same page (e.g. the demo sign-in never leaves it): the memory copy is offered
    expect(readRecovery(s, 'o').map((e) => e.key)).toEqual(['new']);
  });

  it('no storage at all (blocked): memory only', () => {
    expect(writeRecovery(null, 'o', [entry('m')])).toBe(false);
    expect(readRecovery(null, 'o').map((e) => e.key)).toEqual(['m']);
    expect(carriedCount(null)).toBe(1);
  });
});

describe('carried shapes', () => {
  it('validPrefill: quick create and mail (candidate + its version), nothing else', () => {
    const mail = {
      candidateId: 4,
      version: 1,
      subject: 's',
      sender: 'x',
      productName: 'p',
      brandName: null,
      sourceType: 'loan',
      writeDueOn: '2026-11-01',
      publishPlannedOn: null,
      embargoUntil: null,
      memo: 'm',
    };
    expect(validPrefill({})).toEqual({});
    expect(validPrefill({ productName: 'a', anchorField: 'shoot', anchorDate: '2026-10-26' })).not.toBeNull();
    expect(validPrefill({ mail })?.mail?.version).toBe(1);
    for (const bad of [null, [], { anchorField: 'nope' }, { anchorDate: '26.10.2026' }, { mail: { ...mail, version: 0 } }, { mail: { ...mail, sourceType: 'x' } }]) {
      expect(validPrefill(bad)).toBeNull();
    }
  });

  it('carriedForm: same shape as the form, within its inputs’ maxLength', () => {
    const template = { title: '', dueOn: '', done: false };
    const ok = { initial: template, form: { title: 'a', dueOn: '', done: true } };
    expect(carriedForm(ok, template, { title: 3 })).toEqual(ok);
    expect(carriedForm({ initial: template, form: { title: 'abcd', dueOn: '', done: true } }, template, { title: 3 })).toBeNull();
    expect(carriedForm({ initial: template, form: { title: 1, dueOn: '', done: true } }, template)).toBeNull();
    expect(carriedForm({ initial: template, form: { title: 'a', dueOn: '', done: true, extra: 'x' } }, template)).toBeNull();
    expect(carriedForm('x', template)).toBeNull();
  });
});
