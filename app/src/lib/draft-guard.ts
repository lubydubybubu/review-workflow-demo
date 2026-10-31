import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { isDraftDirty, type EditorDraft } from './editor-draft';
import { useUnsavedOwner, useUnsavedRegistry, type UnsavedOwner } from './unsaved';

/**
 * Unsaved edits outlive the editor. While an editor (task page, review page) is dirty, its draft and the version
 * it is saved against are kept for this tab under the row's id: in memory by the app's unsaved-input registry
 * (`./unsaved`, the authoritative copy while the tab lives) and mirrored to sessionStorage (for a reload). Leaving
 * the page by any route (breadcrumb, sidebar, Ctrl+K, browser Back / Forward) and coming back restores both; so
 * does a reload, if the mirror held. The restored draft keeps its ORIGINAL base version: if the row changed
 * meanwhile, a save is still refused as stale. The copies are removed once the editor is clean again (saved,
 * reloaded, discarded).
 *
 * sessionStorage is only a recovery aid, never a reason to drop input: when it cannot hold the current draft
 * (quota, storage blocked, a throwing getter) the older stored copy is removed rather than left to be restored
 * later, the editor says so, and a page change asks before leaving (see `./unsaved`).
 */

const PREFIX = 'review-workflow:draft:';

export function draftKey(kind: 'review' | 'task', id: number): string {
  return `${PREFIX}${kind}:${id}`;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** This tab's sessionStorage, or null where reading it throws (storage blocked by browser policy). */
export function sessionStore(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Stores the draft; false when it could not be stored (no storage, quota, storage disabled). A failed write never
 * leaves an older copy behind to be restored later in place of the current input.
 */
export function storeDraft<F>(storage: Store | null, key: string, draft: EditorDraft<F>): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(draft));
    return true;
  } catch {
    forgetDraft(storage, key);
    return false;
  }
}

export function forgetDraft(storage: Store | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // storage disabled
  }
}

/** Same keys as the template, each the same kind of value (string, or array of strings). */
export function sameShape<F extends object>(value: unknown, template: F): value is F {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(template);
  if (Object.keys(value).length !== keys.length) return false;
  return keys.every((k) => {
    const want = (template as Record<string, unknown>)[k];
    const got = (value as Record<string, unknown>)[k];
    if (Array.isArray(want)) return Array.isArray(got) && got.every((x) => typeof x === 'string');
    return typeof got === typeof want;
  });
}

/**
 * `value` as a well-formed, still-dirty draft of this form: same shape as `template`, a positive integer base
 * version; else null. The base version is NOT compared with the props: Back may render the router's cached
 * (older) copy of the page, and the draft's own version is the right one either way — newer props show it as
 * stale, older props are never adopted over it (`rebaseDraft`).
 */
export function validDraft<F extends object>(value: unknown, template: F): EditorDraft<F> | null {
  const d = value as Partial<EditorDraft<unknown>> | null;
  const ok =
    typeof d === 'object' &&
    d !== null &&
    Number.isSafeInteger(d.baseVersion) &&
    (d.baseVersion as number) > 0 &&
    sameShape(d.initial, template) &&
    sameShape(d.form, template);
  if (!ok) return null;
  const draft: EditorDraft<F> = { initial: d.initial as F, form: d.form as F, baseVersion: d.baseVersion as number };
  return isDraftDirty(draft) ? draft : null;
}

/** The stored draft for `key` if it is valid (`validDraft`); anything else stored there is removed. */
export function readStoredDraft<F extends object>(storage: Store | null, key: string, template: F): EditorDraft<F> | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null; // storage disabled
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    forgetDraft(storage, key);
    return null;
  }
  const draft = validDraft(parsed, template);
  if (!draft) forgetDraft(storage, key);
  return draft;
}

const noSubscribe = () => () => {};

/**
 * Wires an editor to the guard: on mount, a kept draft for `storageKey` (memory first, then sessionStorage) is
 * handed to `restore` (which replaces the editor's state with it); afterwards every dirty state is kept and a clean
 * one forgets it. The editor is registered as a page-level owner of unsaved input; `discard` (the owner agreed to
 * drop the draft before leaving) must put the editor back on the stored row. Returns whether the current draft was
 * restored (for the notice), a function to drop that flag, and whether the storage mirror failed (for its notice).
 */
export function useDraftGuard<F extends object>({
  storageKey,
  label,
  href,
  draft,
  template,
  restore,
  discard,
}: {
  storageKey: string;
  /** for the leave question, e.g. 리뷰 편집 */
  label: string;
  /** this editor's page */
  href: string;
  draft: EditorDraft<F>;
  /** the row's current form, for validating a kept draft */
  template: F;
  restore: (stored: EditorDraft<F>) => void;
  discard: () => void;
}): { restored: boolean; dismissRestored: () => void; notStored: boolean } {
  const registry = useUnsavedRegistry();
  const [restored, setRestored] = useState(false);
  const ready = useRef(false);
  const dirty = isDraftDirty(draft);
  // the restored draft was saved or discarded: the notice is done
  if (restored && !dirty) setRestored(false);

  const persisted = useSyncExternalStore(
    registry?.subscribe ?? noSubscribe,
    () => registry?.kept(storageKey)?.persisted ?? true,
    () => true,
  );

  // Declared before the read below, so on mount it is skipped and cannot forget the copy before it is read.
  useEffect(() => {
    if (!ready.current) return;
    const storage = sessionStore();
    if (dirty) {
      const stored = storeDraft(storage, storageKey, draft);
      registry?.keep({ key: storageKey, label, href, draft, persisted: stored });
    } else {
      registry?.drop(storageKey);
      forgetDraft(storage, storageKey);
    }
  }, [registry, storageKey, label, href, draft, dirty]);

  // Read once per mount: this tab's memory copy is the newest; sessionStorage serves a fresh load or reload. A draft
  // carried across a sign-in is not restored on its own: the shell offers it (복원 hands it over, below); only input
  // typed since that sign-in (this tab's memory copy) comes back meanwhile.
  const mount = useRef({ storageKey, template, restore, setRestored, registry });
  useEffect(() => {
    const m = mount.current;
    const carried = m.registry?.isCarried(m.storageKey) ?? false;
    const inMemory = m.registry?.kept(m.storageKey);
    if (carried && !inMemory) {
      ready.current = true;
      return;
    }
    const stored = (inMemory && validDraft(inMemory.draft, m.template)) || (carried ? null : readStoredDraft(sessionStore(), m.storageKey, m.template));
    if (inMemory && !stored) m.registry?.drop(m.storageKey);
    ready.current = true;
    if (stored) {
      m.restore(stored);
      m.setRestored(true);
    }
  }, []);

  useUnsavedOwner({
    label,
    scope: 'route',
    dirty,
    keepKey: storageKey,
    discard: () => {
      registry?.drop(storageKey);
      forgetDraft(sessionStore(), storageKey);
      discard();
    },
    recovery: {
      key: storageKey,
      href,
      data: dirty ? draft : undefined,
      restore: (data) => {
        const carried = validDraft(data, template);
        if (!carried) return;
        restore(carried);
        setRestored(true);
      },
    },
  });

  return { restored, dismissRestored: () => setRestored(false), notStored: dirty && !persisted };
}

/**
 * `useUnsavedOwner` for a page's small add form (새 할 일, 연결된 할 일 추가, 체크리스트 항목 추가): its unsaved input
 * (`recovery.data`) is kept for this tab like an editor draft — in memory by the registry, mirrored to
 * sessionStorage under the recovery key — so browser Back / Forward, which cannot be held, does not lose it: the
 * form gets it back (`recovery.restore`, which validates it) when it mounts again. A page change still asks
 * (`keptForHistory`). Never saved; forgotten once the form is clean again (added) or its input is discarded. A
 * form without `recovery` (the checklist inside the peek) is a plain owner.
 */
export function useKeptOwner(owner: UnsavedOwner): void {
  const registry = useUnsavedRegistry();
  const key = owner.recovery?.key;
  const data = owner.recovery?.data;
  const json = data === undefined ? undefined : JSON.stringify(data);
  const { label } = owner;
  const href = owner.recovery?.href ?? '';
  const ready = useRef(false);

  // Declared before the read below, so on mount it is skipped and cannot forget the copy before it is read.
  useEffect(() => {
    if (!ready.current || !key) return;
    const storage = sessionStore();
    if (json !== undefined) {
      let stored = false;
      try {
        storage?.setItem(key, json);
        stored = storage !== null;
      } catch {
        forgetDraft(storage, key);
      }
      registry?.keep({ key, label, href, draft: JSON.parse(json), persisted: stored });
    } else {
      registry?.drop(key);
      forgetDraft(storage, key);
    }
  }, [registry, key, json, label, href]);

  // Read once per mount: this tab's memory copy first, then sessionStorage. Taken out of both stores and handed to
  // the form; the effect above keeps it again once the form holds it (an invalid copy is gone). A copy carried
  // across a sign-in is not restored on its own: the shell offers it; only input typed since (memory) comes back.
  const mount = useRef({ key, registry, restore: owner.recovery?.restore });
  useEffect(() => {
    const m = mount.current;
    ready.current = true;
    if (!m.key || !m.restore) return;
    const carried = m.registry?.isCarried(m.key) ?? false;
    let kept: unknown = m.registry?.kept(m.key)?.draft;
    if (carried && kept === undefined) return;
    const storage = sessionStore();
    if (kept === undefined) {
      try {
        const raw = storage?.getItem(m.key);
        kept = raw ? JSON.parse(raw) : undefined;
      } catch {
        kept = undefined; // unreadable or not JSON
      }
    }
    m.registry?.drop(m.key);
    forgetDraft(storage, m.key);
    if (kept !== undefined) m.restore(kept);
  }, []);

  useUnsavedOwner({
    ...owner,
    keepKey: key,
    keptForHistory: true,
    discard: () => {
      if (key) {
        registry?.drop(key);
        forgetDraft(sessionStore(), key);
      }
      owner.discard();
    },
  });
}
