import { describe, expect, it } from 'vitest';
import { draftKey, forgetDraft, readStoredDraft, sessionStore, storeDraft, validDraft } from '../../src/lib/draft-guard';
import { openDraft, type EditorDraft } from '../../src/lib/editor-draft';

type Form = { title: string; memo: string; channels: string[] };
const stored: Form = { title: '저장된 제목', memo: '저장된 메모', channels: ['youtube'] };
const dirty: EditorDraft<Form> = { ...openDraft(stored, 1), form: { ...stored, memo: '저장 안 한 메모' } };

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe('draft guard storage (unsaved edits survive leaving the editor)', () => {
  it('keys are per entity kind and id', () => {
    expect(draftKey('review', 35)).toBe('review-workflow:draft:review:35');
    expect(draftKey('task', 35)).not.toBe(draftKey('review', 35));
  });

  it('a stored dirty draft comes back with its ORIGINAL base version, whatever version the page shows now', () => {
    const s = memoryStorage();
    const key = draftKey('review', 1);
    storeDraft(s, key, dirty);
    // the row is newer now (another tab saved): still version 1, so the save is refused as stale
    const back = readStoredDraft(s, key, { ...stored, title: '다른 탭 제목' });
    expect(back).toEqual(dirty);
    expect(back?.baseVersion).toBe(1);
    // Back may show the router's cached older page; a draft saved against version 9 keeps 9
    const later = { ...dirty, baseVersion: 9 };
    storeDraft(s, key, later);
    expect(readStoredDraft(s, key, stored)?.baseVersion).toBe(9);
  });

  it('forget removes it; nothing stored reads as null', () => {
    const s = memoryStorage();
    const key = draftKey('task', 7);
    storeDraft(s, key, dirty);
    forgetDraft(s, key);
    expect(readStoredDraft(s, key, stored)).toBeNull();
  });

  it('a clean, malformed or wrongly shaped copy is dropped (and removed)', () => {
    const key = draftKey('review', 2);
    const cases: string[] = [
      JSON.stringify(openDraft(stored, 1)), // clean
      '{not json',
      JSON.stringify({ ...dirty, baseVersion: 0 }),
      JSON.stringify({ ...dirty, baseVersion: 1.5 }),
      JSON.stringify({ ...dirty, baseVersion: '1' }),
      JSON.stringify({ ...dirty, form: { title: 'x', memo: 'y' } }), // missing key
      JSON.stringify({ ...dirty, form: { ...dirty.form, extra: 'z' } }),
      JSON.stringify({ ...dirty, form: { ...dirty.form, memo: 5 } }),
      JSON.stringify({ ...dirty, form: { ...dirty.form, channels: 'youtube' } }),
      JSON.stringify({ ...dirty, initial: null }),
      'null',
    ];
    for (const raw of cases) {
      const s = memoryStorage();
      s.setItem(key, raw);
      expect(readStoredDraft(s, key, stored), raw).toBeNull();
      expect(s.map.has(key), raw).toBe(false);
    }
  });

  it('storage that throws (disabled, full) never breaks the editor', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(() => storeDraft(broken, 'k', dirty)).not.toThrow();
    expect(() => forgetDraft(broken, 'k')).not.toThrow();
    expect(readStoredDraft(broken, 'k', stored)).toBeNull();
  });

  it('a write that fails (quota) reports it and leaves NO older copy to be restored in place of the newer input', () => {
    const s = memoryStorage();
    const key = draftKey('review', 4);
    expect(storeDraft(s, key, dirty)).toBe(true);
    const full = {
      ...s,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    const later = { ...dirty, form: { ...dirty.form, memo: '더 최근 메모' } };
    expect(storeDraft(full, key, later)).toBe(false);
    expect(s.map.has(key)).toBe(false);
    expect(readStoredDraft(s, key, stored)).toBeNull();
  });

  it('no storage at all (the getter throws: storage blocked): nothing stored, nothing read, reported as not stored', () => {
    expect(storeDraft(null, 'k', dirty)).toBe(false);
    expect(readStoredDraft(null, 'k', stored)).toBeNull();
    expect(() => forgetDraft(null, 'k')).not.toThrow();
    // outside a browser `window` is absent: the guard treats that like blocked storage
    expect(sessionStore()).toBeNull();
  });

  it('validDraft: the same checks for a memory copy as for a stored one', () => {
    expect(validDraft(dirty, stored)).toEqual(dirty);
    expect(validDraft(openDraft(stored, 2), stored)).toBeNull(); // clean
    expect(validDraft({ ...dirty, baseVersion: 0 }, stored)).toBeNull();
    expect(validDraft({ ...dirty, form: { title: 'x' } }, stored)).toBeNull();
    expect(validDraft(undefined, stored)).toBeNull();
  });
});
