import { describe, expect, it } from 'vitest';
import { isDraftDirty, openDraft, rebaseDraft, type EditorDraft } from '../../src/lib/editor-draft';

type Form = { title: string; memo: string };
const stored: Form = { title: '저장된 제목', memo: '저장된 메모' };
const newer: Form = { title: '다른 탭 제목', memo: '저장된 메모' };

describe('editor draft ↔ version pairing (shared by the task and review editors)', () => {
  it('opening pairs the stored values with their version; untouched is not dirty', () => {
    const d = openDraft(stored, 1);
    expect(d).toEqual({ initial: stored, form: stored, baseVersion: 1 });
    expect(isDraftDirty(d)).toBe(false);
    expect(isDraftDirty({ ...d, form: { ...stored, memo: '바뀜' } })).toBe(true);
  });

  it('an untouched draft follows a newer row: values and version together', () => {
    const next = rebaseDraft(openDraft(stored, 1), 2, () => newer);
    expect(next).toEqual({ initial: newer, form: newer, baseVersion: 2 });
  });

  it('a dirty draft keeps its form AND its old version when a newer row arrives (the later save is stale)', () => {
    const dirty: EditorDraft<Form> = { ...openDraft(stored, 1), form: { ...stored, memo: '저장 안 한 메모' } };
    let read = false;
    const next = rebaseDraft(dirty, 2, () => {
      read = true;
      return newer;
    });
    expect(next).toBe(dirty);
    expect(next.baseVersion).toBe(1);
    expect(next.form.memo).toBe('저장 안 한 메모');
    expect(read).toBe(false);
  });

  it('the same or an older version (a refresh racing the owner’s own save) is never adopted', () => {
    const saved = openDraft(newer, 3);
    expect(rebaseDraft(saved, 3, () => stored)).toBe(saved);
    expect(rebaseDraft(saved, 2, () => stored)).toBe(saved);
  });

  it('a draft edited back to the stored values counts as clean and follows again', () => {
    const d: EditorDraft<Form> = { ...openDraft(stored, 1), form: { ...stored } };
    expect(isDraftDirty(d)).toBe(false);
    expect(rebaseDraft(d, 2, () => newer).baseVersion).toBe(2);
  });
});
