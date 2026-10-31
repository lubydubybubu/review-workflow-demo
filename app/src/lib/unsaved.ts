import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

/**
 * Unsaved input, app-wide. One registry (owned by the app shell, one per tab) knows every open form that holds
 * unsaved input ("owners"), and every transition that could unmount or replace one asks it first: in-app links,
 * programmatic navigation, replacing or dismissing an overlay (Ctrl+K over a creation dialog, Esc, backdrop), logout.
 * A transition that would lose input it cannot keep is held until the owner answers: 계속 편집 (nothing changes,
 * inputs and their base version stay) or 버리고 … (only the affected inputs are dropped, then the transition runs).
 * Clean forms, and inputs that survive the transition, never ask.
 *
 * Who survives what:
 * - `route` owners (the review / task page editors) are unmounted by a page change. Their drafts are kept in this
 *   tab's memory here (`keep`), the authoritative copy for as long as the tab lives, and mirrored to sessionStorage
 *   for a reload. A page change only asks when that mirror failed (quota, storage blocked): the draft would not
 *   survive a reload, so leaving is not treated as safe. Browser Back / Forward cannot be held; the memory copy
 *   restores the draft on return, and the unload prompt stays on while such a draft exists anywhere in the tab.
 * - `overlay` owners (quick create, mail register) live in the shell's single overlay slot: replacing or dismissing
 *   the overlay asks. A page change does not touch them.
 * - `shell` owners (the review peek) outlive page changes and overlays; only leaving the app (logout) asks for them.
 *   The peek keeps its own close / switch question.
 * Reload, tab close and external navigation: the browser's unload prompt while anything is unsaved.
 * A page's own dialog (e.g. 기존 리뷰에 연결) asks about just its input before it is dismissed (`confirm`).
 *
 * Sign-in ends under an open form (session expired / ended: the server redirects to /login, which is outside the
 * shell): that is not a transition anyone asked for, and it cannot be held — authentication fails closed. So the
 * shell, as it unmounts, carries every unsaved input that has a `recovery` to this tab's sessionStorage
 * (`recoverable`, `@/lib/recovery`); after the next sign-in in this tab the shell offers each one (`offer`):
 * 복원 puts it back into its form (`startRestore` → the owner `take`s it), with the base version it was edited
 * against, so a save is still refused if the row changed meanwhile; 버리기 drops it. Nothing is saved for the owner.
 * 복원 over newer input of the same form (typed after the sign-in) asks first (`requestRestore`).
 */

export type OwnerScope = 'route' | 'overlay' | 'shell';
export type TransitionKind = 'route' | 'overlay' | 'leave';

/** How the shell reopens an input that does not live on a page of its own. */
export type RecoveryOpen = { kind: 'create'; prefill: unknown } | { kind: 'peek'; id: number };

/** An unsaved input as carried across a sign-in. */
export interface RecoveryEntry {
  /** identifies the input; also the key of any sessionStorage mirror the owner keeps (dropped with it) */
  key: string;
  label: string;
  /** the page it is edited on */
  href: string;
  open?: RecoveryOpen;
  /** the owner's own shape, validated by the owner when it takes it back */
  data: unknown;
}

export interface UnsavedOwner {
  /** what the question lists, e.g. 리뷰 편집 */
  label: string;
  scope: OwnerScope;
  dirty: boolean;
  /** drop the unsaved input (the owner agreed to discard it) */
  discard: () => void;
  /** route owners: the key of the draft they keep (`keep`); kept and mirrored to storage = survives a page change */
  keepKey?: string;
  /**
   * the kept draft only covers browser Back / Forward (a page's small add form, `useKeptOwner`): a page change
   * still asks, as there is no editor holding it to come back to
   */
  keptForHistory?: boolean;
  /** carried across a sign-in (see above); `data` is undefined while there is nothing unsaved to carry */
  recovery?: Omit<RecoveryEntry, 'label' | 'data'> & {
    data: unknown;
    /** puts carried input back into the form (복원 after sign-in); must validate it */
    restore: (data: unknown) => void;
  };
}

/** A route owner's draft as kept in memory for this tab. */
export interface KeptDraft {
  key: string;
  label: string;
  /** where the draft is edited (for the "not stored" notice) */
  href: string;
  draft: unknown;
  /** the sessionStorage mirror holds exactly this draft (survives a reload) */
  persisted: boolean;
}

export interface Blocker {
  label: string;
  note?: string;
  discard: () => void;
}

export interface PendingTransition {
  /** `dismiss`: a page dialog asking about its own input (`confirm`); `restore`: 복원 over newer input */
  kind: TransitionKind | 'dismiss' | 'restore';
  /** the verb on the discard button: 버리고 {action} */
  action: string;
  blockers: Blocker[];
  proceed: () => void;
}

export const NOT_STORED_NOTE = '이 탭에 보관하지 못했습니다';

const AFFECTS: Record<TransitionKind, readonly OwnerScope[]> = {
  route: ['route'],
  overlay: ['overlay'],
  leave: ['route', 'overlay', 'shell'],
};

export class UnsavedRegistry {
  private owners = new Map<number, () => UnsavedOwner>();
  private keptDrafts = new Map<string, KeptDraft>();
  private nextId = 1;
  private listeners = new Set<() => void>();
  private version = 0;
  private question: PendingTransition | null = null;

  /** Registers an owner (read at question time, so it is always current); returns the unregister function. */
  register(read: () => UnsavedOwner): () => void {
    const id = this.nextId++;
    this.owners.set(id, read);
    this.emit();
    return () => {
      if (this.owners.delete(id)) this.emit();
    };
  }

  keep(entry: KeptDraft): void {
    const before = this.keptDrafts.get(entry.key);
    this.keptDrafts.set(entry.key, entry);
    if (!before || before.persisted !== entry.persisted) this.emit();
  }

  kept(key: string): KeptDraft | undefined {
    return this.keptDrafts.get(key);
  }

  drop(key: string): void {
    if (this.keptDrafts.delete(key)) this.emit();
  }

  private mountedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const read of this.owners.values()) {
      const key = read().keepKey;
      if (key) keys.add(key);
    }
    return keys;
  }

  /** Kept drafts whose editor is not open and that would not survive a reload. */
  keptAway(): KeptDraft[] {
    const mounted = this.mountedKeys();
    return [...this.keptDrafts.values()].filter((k) => !k.persisted && !mounted.has(k.key));
  }

  /** The unsaved inputs a `kind` transition would lose. */
  blockers(kind: TransitionKind): Blocker[] {
    const scopes = AFFECTS[kind];
    const out: Blocker[] = [];
    for (const read of this.owners.values()) {
      const o = read();
      if (!o.dirty || !scopes.includes(o.scope)) continue;
      const kept = o.keepKey ? this.keptDrafts.get(o.keepKey) : undefined;
      if (o.keptForHistory) {
        out.push({ label: o.label, discard: o.discard });
        continue;
      }
      if (kept?.persisted) continue; // survives: restored on return, also after a reload
      out.push({ label: o.label, note: o.keepKey ? NOT_STORED_NOTE : undefined, discard: o.discard });
    }
    if (kind === 'leave') {
      for (const k of this.keptAway()) out.push({ label: k.label, note: NOT_STORED_NOTE, discard: () => this.drop(k.key) });
    }
    return out;
  }

  /** Whether unloading the page now would lose anything (the unload prompt). */
  hasUnsaved(): boolean {
    for (const read of this.owners.values()) if (read().dirty) return true;
    for (const k of this.keptDrafts.values()) if (!k.persisted) return true;
    return false;
  }

  /**
   * Run `proceed` now if nothing would be lost, else ask (one question at a time: a second request while one is
   * showing is ignored).
   */
  request(kind: TransitionKind, action: string, proceed: () => void): 'proceeded' | 'asked' | 'busy' {
    if (this.question) return 'busy';
    return this.ask(kind, this.blockers(kind), action, proceed);
  }

  /** The same question about exactly these inputs: a page dialog that is about to be dismissed. */
  confirm(blockers: Blocker[], action: string, proceed: () => void): 'proceeded' | 'asked' | 'busy' {
    if (this.question) return 'busy';
    return this.ask('dismiss', blockers, action, proceed);
  }

  private ask(kind: PendingTransition['kind'], blockers: Blocker[], action: string, proceed: () => void): 'proceeded' | 'asked' {
    if (blockers.length === 0) {
      proceed();
      return 'proceeded';
    }
    this.question = { kind, action, blockers, proceed };
    this.emit();
    return 'asked';
  }

  get pending(): PendingTransition | null {
    return this.question;
  }

  asking = (): boolean => this.question !== null;

  /** 계속 편집: nothing is dropped, the transition does not happen. */
  cancel(): void {
    if (!this.question) return;
    this.question = null;
    this.emit();
  }

  /** 버리고 …: drop exactly the inputs the question listed, then run the transition. */
  accept(): void {
    const q = this.question;
    if (!q) return;
    this.question = null;
    for (const b of q.blockers) b.discard();
    this.emit();
    q.proceed();
  }

  // ---- carried across a sign-in

  private offered: RecoveryEntry[] = [];
  /** 복원 chosen, waiting for its owner to mount and take it */
  private restoring = new Map<string, RecoveryEntry>();

  /**
   * Everything unsaved this tab would lose if the shell went away now: inputs of mounted owners that have a
   * `recovery`, kept page drafts whose editor is closed, and earlier carried inputs not yet restored or dropped.
   */
  recoverable(): RecoveryEntry[] {
    const out = new Map<string, RecoveryEntry>();
    for (const e of this.pendingRecovery()) out.set(e.key, e);
    for (const k of this.keptDrafts.values()) out.set(k.key, { key: k.key, label: k.label, href: k.href, data: k.draft });
    for (const read of this.owners.values()) {
      const o = read();
      if (!o.recovery || o.recovery.data === undefined) continue;
      const { restore: _restore, ...entry } = o.recovery;
      out.set(entry.key, { ...entry, label: o.label });
    }
    return [...out.values()];
  }

  /** Carried inputs not yet restored into their form or dropped (what must stay stored). */
  pendingRecovery(): RecoveryEntry[] {
    return [...this.offered, ...this.restoring.values()];
  }

  /** Offers carried inputs (after a sign-in): each waits for 복원 or 버리기. */
  offer(entries: RecoveryEntry[]): void {
    const seen = new Set<string>();
    this.offered = entries.filter((e) => !this.restoring.has(e.key) && !seen.has(e.key) && seen.add(e.key));
    this.emit();
  }

  get offers(): RecoveryEntry[] {
    return this.offered;
  }

  /** An input for `key` is carried and not settled: its editor must not restore an older copy on its own. */
  isCarried(key: string): boolean {
    return this.restoring.has(key) || this.offered.some((e) => e.key === key);
  }

  /**
   * Before 복원 of `key`: the newer input it would replace — its form open with unsaved input, or its page draft
   * kept while that page is closed — is asked about first, with the same question (계속 편집: nothing changes, the
   * offer stays; 버리고 복원: `proceed`, and the restored input replaces it in its form and its kept copy).
   * Nothing newer: `proceed` at once.
   */
  requestRestore(key: string, proceed: () => void): 'proceeded' | 'asked' | 'busy' {
    if (this.question) return 'busy';
    const replaced: Blocker[] = [];
    let mounted = false;
    for (const read of this.owners.values()) {
      const o = read();
      if (o.recovery?.key !== key) continue;
      mounted = true;
      if (o.dirty) replaced.push({ label: o.label, discard: () => {} });
    }
    const kept = this.keptDrafts.get(key);
    if (!mounted && kept) replaced.push({ label: kept.label, discard: () => {} });
    return this.ask('restore', replaced, '복원', proceed);
  }

  /**
   * 복원: the entry waits for its owner (`take`), which may take it at once if it is mounted; returns it, for the
   * shell to open its form. Again for an entry still waiting (its form was not reached).
   */
  startRestore(key: string): RecoveryEntry | undefined {
    const waiting = this.restoring.get(key);
    if (waiting) {
      this.emit();
      return waiting;
    }
    const entry = this.offered.find((e) => e.key === key);
    if (!entry) return undefined;
    this.offered = this.offered.filter((e) => e !== entry);
    this.restoring.set(key, entry);
    this.emit();
    return entry;
  }

  /** The owner of `key` takes back the input chosen for 복원 (once), or undefined. */
  take(key: string): unknown {
    const entry = this.restoring.get(key);
    if (!entry) return undefined;
    this.restoring.delete(key);
    this.emit();
    return entry.data;
  }

  /** 버리기: the carried input is dropped. */
  dropCarried(key: string): void {
    const before = this.offered.length;
    this.offered = this.offered.filter((e) => e.key !== key);
    if (this.restoring.delete(key) || this.offered.length !== before) this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const UnsavedContext = createContext<UnsavedRegistry | null>(null);

export function useUnsavedRegistry(): UnsavedRegistry | null {
  return useContext(UnsavedContext);
}

/**
 * Registers this component as an owner while it is mounted; the latest `owner` is what a question sees. An input
 * chosen for 복원 after a sign-in is handed to `owner.recovery.restore` (now, or once it mounts). Returns
 * `confirm(action, proceed)`: runs `proceed` at once while clean, else asks about this input first (a dialog's
 * own dismissal: 계속 편집 keeps it, 버리고 {action} discards it, then proceeds).
 */
export function useUnsavedOwner(owner: UnsavedOwner): { confirm: (action: string, proceed: () => void) => void } {
  const registry = useContext(UnsavedContext);
  const current = useRef(owner);
  useEffect(() => {
    current.current = owner;
  });
  useEffect(() => registry?.register(() => current.current), [registry]);

  const recoveryKey = owner.recovery?.key;
  useEffect(() => {
    if (!registry || !recoveryKey) return;
    const apply = () => {
      const data = registry.take(recoveryKey);
      if (data !== undefined) current.current.recovery?.restore(data);
    };
    apply();
    return registry.subscribe(apply);
  }, [registry, recoveryKey]);

  return useMemo(
    () => ({
      confirm: (action: string, proceed: () => void) => {
        const o = current.current;
        if (!registry || !o.dirty) proceed();
        else registry.confirm([{ label: o.label, discard: o.discard }], action, proceed);
      },
    }),
    [registry],
  );
}

/** `useRouter`, with push / replace to another page asking first when that would lose unsaved input. */
export function useGuardedRouter(): ReturnType<typeof useRouter> {
  const router = useRouter();
  const registry = useContext(UnsavedContext);
  return useMemo(() => {
    const guard =
      (go: (href: string, options?: { scroll?: boolean }) => void) =>
      (href: string, options?: { scroll?: boolean }) => {
        const samePage = new URL(href, window.location.href).pathname === window.location.pathname;
        if (!registry || samePage) go(href, options);
        else registry.request('route', '이동', () => go(href, options));
      };
    return {
      ...router,
      push: guard((href, options) => router.push(href, options)),
      replace: guard((href, options) => router.replace(href, options)),
    };
  }, [router, registry]);
}
