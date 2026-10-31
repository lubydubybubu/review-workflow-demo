import type { MailPrefill, QuickCreatePrefill } from '@/components/shell-context';
import { ANCHOR_FIELDS, SOURCE_TYPES } from './domain/review';
import { sameShape } from './draft-guard';
import type { RecoveryEntry, RecoveryOpen } from './unsaved';

/**
 * Unsaved inputs carried across a sign-in (see `./unsaved`): stored in this tab's sessionStorage when the shell
 * unmounts (the session ended and the server sent the tab to /login), read back by the next shell after the
 * sign-in, kept stored until each one is restored or dropped. Tagged with the signed-in owner, so only the same
 * owner is offered them; anything else found there is removed.
 *
 * Also kept in this page's memory: a sign-in that never leaves the page (the demo password form) still gets them
 * back when storage is unavailable. A sign-in through another site is a full page load: then only storage carries
 * them, and when storage is unavailable they are lost — the editors' own notices already say so while editing.
 */

export const RECOVERY_KEY = 'review-workflow:recovery';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface Stored {
  v: 1;
  owner: string;
  entries: RecoveryEntry[];
}

let memory: Stored | null = null;

function forget(store: Store | null): void {
  try {
    store?.removeItem(RECOVERY_KEY);
  } catch {
    // storage disabled
  }
}

/**
 * Stores the carried inputs (none: removes them). False when storage could not hold them; then no older copy is
 * left behind either (it could bring back an input that was dropped since).
 */
export function writeRecovery(store: Store | null, owner: string, entries: RecoveryEntry[]): boolean {
  memory = entries.length > 0 ? { v: 1, owner, entries } : null;
  if (!store) return false;
  try {
    if (memory) store.setItem(RECOVERY_KEY, JSON.stringify(memory));
    else store.removeItem(RECOVERY_KEY);
    return true;
  } catch {
    forget(store);
    return false;
  }
}

/** The carried inputs for this owner (memory first, then storage); another owner's, or malformed ones, are removed. */
export function readRecovery(store: Store | null, owner: string): RecoveryEntry[] {
  let stored: unknown = memory;
  if (!stored && store) {
    try {
      const raw = store.getItem(RECOVERY_KEY);
      stored = raw === null ? null : JSON.parse(raw);
    } catch {
      stored = undefined; // unreadable or not JSON
    }
  }
  if (stored === null) return [];
  const s = stored as Partial<Stored> | undefined;
  const entries = s?.v === 1 && s.owner === owner && Array.isArray(s.entries) ? s.entries.filter(validEntry) : [];
  if (entries.length === 0) {
    memory = null;
    forget(store);
  }
  return entries;
}

/** How many inputs are carried in this tab, for whoever signs in next (the login page says so); 0 if none. */
export function carriedCount(store: Store | null): number {
  if (memory) return memory.entries.length;
  try {
    const raw = store?.getItem(RECOVERY_KEY);
    const s = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    return s?.v === 1 && Array.isArray(s.entries) ? s.entries.filter(validEntry).length : 0;
  } catch {
    return 0;
  }
}

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

function validOpen(v: unknown): v is RecoveryOpen {
  const o = v as Partial<{ kind: string; prefill: unknown; id: unknown }> | null;
  if (typeof o !== 'object' || o === null) return false;
  if (o.kind === 'create') return validPrefill(o.prefill) !== null;
  return o.kind === 'peek' && Number.isSafeInteger(o.id) && (o.id as number) > 0;
}

function validEntry(v: unknown): v is RecoveryEntry {
  const e = v as Partial<RecoveryEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    text(e.key, 200) &&
    text(e.label, 200) &&
    // a path in this app only, never another origin
    text(e.href, 500) &&
    e.href.startsWith('/') &&
    !e.href.startsWith('//') &&
    !e.href.includes('\\') &&
    e.data !== undefined &&
    (e.open === undefined || validOpen(e.open))
  );
}

const dateOrNull = (v: unknown) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
const sourceOrNull = (v: unknown) => v === null || SOURCE_TYPES.includes(v as never);
const id = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;

function validMailPrefill(v: unknown): v is MailPrefill {
  const m = v as Partial<Record<keyof MailPrefill, unknown>> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    id(m.candidateId) &&
    id(m.version) &&
    typeof m.subject === 'string' &&
    typeof m.sender === 'string' &&
    typeof m.productName === 'string' &&
    (m.brandName === null || typeof m.brandName === 'string') &&
    sourceOrNull(m.sourceType) &&
    dateOrNull(m.writeDueOn) &&
    dateOrNull(m.publishPlannedOn) &&
    dateOrNull(m.embargoUntil) &&
    typeof m.memo === 'string'
  );
}

/** A creation dialog's prefill as carried, or null. */
export function validPrefill(v: unknown): QuickCreatePrefill | null {
  const p = v as Partial<Record<keyof QuickCreatePrefill, unknown>> | null;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return null;
  const ok =
    (p.productName === undefined || typeof p.productName === 'string') &&
    (p.anchorField === undefined || ANCHOR_FIELDS.includes(p.anchorField as never)) &&
    (p.anchorDate === undefined || (typeof p.anchorDate === 'string' && dateOrNull(p.anchorDate))) &&
    (p.mail === undefined || validMailPrefill(p.mail));
  return ok ? (p as QuickCreatePrefill) : null;
}

/**
 * A form carried as `{ initial, form }` (the state it started from, the input), checked against the form's shape
 * and its fields' length limits (the inputs' maxLength: a carried form never holds more than its form accepts).
 */
export function carriedForm<F extends object>(
  data: unknown,
  template: F,
  maxLength: Partial<Record<keyof F, number>> = {},
): { initial: F; form: F } | null {
  const d = data as { initial?: unknown; form?: unknown } | null;
  if (typeof d !== 'object' || d === null) return null;
  if (!sameShape(d.initial, template) || !sameShape(d.form, template)) return null;
  const form = d.form;
  const fits = (Object.keys(maxLength) as (keyof F)[]).every((k) => {
    const v = form[k];
    return typeof v !== 'string' || v.length <= (maxLength[k] as number);
  });
  return fits ? { initial: d.initial, form } : null;
}
