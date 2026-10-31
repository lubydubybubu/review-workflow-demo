import { describe, expect, it } from 'vitest';
import { NOT_STORED_NOTE, UnsavedRegistry, type UnsavedOwner } from '../../src/lib/unsaved';

/** An owner whose fields the test changes in place (the registry reads them at question time). */
function owner(fields: Partial<UnsavedOwner> & Pick<UnsavedOwner, 'label' | 'scope'>) {
  const state = { dirty: false, discarded: 0, ...fields } as UnsavedOwner & { discarded: number };
  state.discard = () => {
    state.discarded++;
    state.dirty = false;
  };
  return state;
}

function setup() {
  const registry = new UnsavedRegistry();
  const log: string[] = [];
  const go = (what: string) => () => void log.push(what);
  return { registry, log, go };
}

describe('unsaved-input registry and transition gate', () => {
  it('clean owners never ask: every kind of transition proceeds at once', () => {
    const { registry, log, go } = setup();
    for (const scope of ['route', 'overlay', 'shell'] as const) registry.register(() => owner({ label: scope, scope }));
    expect(registry.request('route', '이동', go('route'))).toBe('proceeded');
    expect(registry.request('overlay', '열기', go('overlay'))).toBe('proceeded');
    expect(registry.request('leave', '로그아웃', go('leave'))).toBe('proceeded');
    expect(log).toEqual(['route', 'overlay', 'leave']);
    expect(registry.hasUnsaved()).toBe(false);
    expect(registry.pending).toBeNull();
  });

  it('a dirty creation dialog holds an overlay change (Ctrl+K) until answered; cancel keeps it, nothing runs', () => {
    const { registry, log, go } = setup();
    const create = owner({ label: '새 리뷰', scope: 'overlay', dirty: true });
    registry.register(() => create);
    expect(registry.request('overlay', '열기', go('palette'))).toBe('asked');
    expect(registry.pending?.blockers.map((b) => b.label)).toEqual(['새 리뷰']);
    // a second Ctrl+K while the question shows is ignored, not queued
    expect(registry.request('overlay', '열기', go('palette again'))).toBe('busy');
    registry.cancel();
    expect(log).toEqual([]);
    expect([create.dirty, create.discarded]).toEqual([true, 0]);
    expect(registry.pending).toBeNull();
    // a page change does not unmount it: never asks for it
    expect(registry.request('route', '이동', go('route'))).toBe('proceeded');
    expect(log).toEqual(['route']);
  });

  it('accept discards exactly the affected inputs, then runs the transition', () => {
    const { registry, log, go } = setup();
    const create = owner({ label: '메일 의뢰 등록', scope: 'overlay', dirty: true });
    const editor = owner({ label: '리뷰 편집', scope: 'route', dirty: true, keepKey: 'k:review:1' });
    const peek = owner({ label: '빠른 편집', scope: 'shell', dirty: true });
    for (const o of [create, editor, peek]) registry.register(() => o);
    registry.keep({ key: 'k:review:1', label: '리뷰 편집', href: '/reviews/1', draft: {}, persisted: false });
    registry.request('overlay', '열기', () => {
      log.push(`palette after discard: ${create.discarded}`);
    });
    registry.accept();
    expect(log).toEqual(['palette after discard: 1']);
    expect([editor.discarded, peek.discarded]).toEqual([0, 0]);
    // the route question lists only the editor
    registry.request('route', '이동', go('board'));
    expect(registry.pending?.blockers.map((b) => [b.label, b.note])).toEqual([['리뷰 편집', NOT_STORED_NOTE]]);
    registry.accept();
    expect([editor.discarded, peek.discarded, log.at(-1)]).toEqual([1, 0, 'board']);
  });

  it('a route owner whose draft is kept AND stored survives a page change (no question); not stored = asks', () => {
    const { registry, log, go } = setup();
    const editor = owner({ label: '할 일 편집', scope: 'route', dirty: true, keepKey: 'k:task:7' });
    registry.register(() => editor);
    // dirty, nothing kept yet (e.g. no keep key written): not preserved → asks
    expect(registry.request('route', '이동', go('x'))).toBe('asked');
    registry.cancel();
    registry.keep({ key: 'k:task:7', label: '할 일 편집', href: '/tasks/7', draft: { v: 1 }, persisted: true });
    expect(registry.request('route', '이동', go('stored'))).toBe('proceeded');
    // the mirror fails on the next keystroke (quota): fail closed
    registry.keep({ key: 'k:task:7', label: '할 일 편집', href: '/tasks/7', draft: { v: 2 }, persisted: false });
    expect(registry.request('route', '이동', go('not stored'))).toBe('asked');
    registry.cancel();
    expect(log).toEqual(['stored']);
    expect(registry.kept('k:task:7')?.draft).toEqual({ v: 2 }); // the latest input, not the stored older one
  });

  it('the unload prompt: any dirty owner, or a kept draft that is only in memory (its editor left by Back)', () => {
    const { registry } = setup();
    const editor = owner({ label: '리뷰 편집', scope: 'route', dirty: true, keepKey: 'k:review:3' });
    const unregister = registry.register(() => editor);
    expect(registry.hasUnsaved()).toBe(true);
    registry.keep({ key: 'k:review:3', label: '리뷰 편집', href: '/reviews/3', draft: {}, persisted: false });
    expect(registry.keptAway()).toEqual([]); // its editor is open: the editor itself says so
    unregister(); // Back unmounted the editor; the memory copy stays
    expect(registry.hasUnsaved()).toBe(true);
    expect(registry.keptAway().map((k) => k.href)).toEqual(['/reviews/3']);
    // a later page change is safe for it (memory survives); leaving the app is not
    expect(registry.request('route', '이동', () => {})).toBe('proceeded');
    const ran: string[] = [];
    expect(registry.request('leave', '로그아웃', () => ran.push('logout'))).toBe('asked');
    registry.cancel();
    expect(registry.kept('k:review:3')).toBeDefined();
    registry.request('leave', '로그아웃', () => ran.push('logout'));
    registry.accept();
    expect([ran, registry.kept('k:review:3'), registry.hasUnsaved()]).toEqual([['logout'], undefined, false]);
  });

  it('a stored kept draft does not hold the unload prompt once its editor is closed', () => {
    const { registry } = setup();
    registry.keep({ key: 'k', label: '리뷰 편집', href: '/reviews/9', draft: {}, persisted: true });
    expect([registry.hasUnsaved(), registry.keptAway()]).toEqual([false, []]);
  });

  it('multiple owners and React remounts: each registration is independent; unregister is idempotent', () => {
    const { registry } = setup();
    const a = owner({ label: 'A', scope: 'overlay', dirty: true });
    const b = owner({ label: 'B', scope: 'overlay', dirty: true });
    const offA1 = registry.register(() => a);
    offA1(); // StrictMode-style mount → unmount → mount
    const offA2 = registry.register(() => a);
    const offB = registry.register(() => b);
    expect(registry.blockers('overlay').map((x) => x.label)).toEqual(['A', 'B']);
    offA1(); // a stale cleanup does not remove the live registration
    expect(registry.blockers('overlay').map((x) => x.label)).toEqual(['A', 'B']);
    offA2();
    expect(registry.blockers('overlay').map((x) => x.label)).toEqual(['B']);
    b.dirty = false; // read at question time: a save just made it clean
    expect(registry.blockers('overlay')).toEqual([]);
    offB();
    expect(registry.hasUnsaved()).toBe(false);
  });

  it('logout lists every unsaved input in the tab; the peek only asks there', () => {
    const { registry } = setup();
    const peek = owner({ label: '빠른 편집', scope: 'shell', dirty: true });
    registry.register(() => peek);
    expect(registry.blockers('route')).toEqual([]);
    expect(registry.blockers('overlay')).toEqual([]);
    expect(registry.blockers('leave').map((b) => b.label)).toEqual(['빠른 편집']);
  });

  it('subscribers hear registrations, kept-draft status changes and questions, not every keystroke', () => {
    const { registry } = setup();
    let calls = 0;
    const off = registry.subscribe(() => calls++);
    const v0 = registry.getVersion();
    registry.keep({ key: 'k', label: 'L', href: '/x', draft: 1, persisted: true });
    registry.keep({ key: 'k', label: 'L', href: '/x', draft: 2, persisted: true }); // same status: quiet
    registry.keep({ key: 'k', label: 'L', href: '/x', draft: 3, persisted: false });
    registry.drop('k');
    registry.drop('k');
    expect(calls).toBe(3);
    const unregister = registry.register(() => owner({ label: 'o', scope: 'overlay', dirty: true }));
    registry.request('overlay', '열기', () => {});
    registry.cancel();
    unregister();
    expect(calls).toBe(7);
    expect(registry.getVersion()).toBe(v0 + 7);
    off();
    registry.drop('nothing');
    registry.keep({ key: 'z', label: 'L', href: '/x', draft: 0, persisted: true });
    expect(calls).toBe(7);
  });

  it('accept / cancel without a question are no-ops', () => {
    const { registry } = setup();
    expect(() => {
      registry.accept();
      registry.cancel();
    }).not.toThrow();
    expect(registry.asking()).toBe(false);
  });
});
