/**
 * An editor's draft and the version it is saved against travel together: `form` is what the owner is
 * editing, `initial` the stored values it started from, `baseVersion` the compare-and-set token for both.
 * Used by every form that edits one versioned row from server props (task page, review page).
 */
export interface EditorDraft<F> {
  initial: F;
  form: F;
  baseVersion: number;
}

export function openDraft<F>(form: F, version: number): EditorDraft<F> {
  return { initial: form, form, baseVersion: version };
}

export function isDraftDirty<F>(draft: EditorDraft<F>): boolean {
  return JSON.stringify(draft.form) !== JSON.stringify(draft.initial);
}

/**
 * A background re-render (another action's revalidation, router.refresh) brought the row at `latestVersion`.
 * An untouched editor follows a newer row — new values and new version together. An editor with unsaved
 * changes keeps both its draft and its old version, so a later save is checked against what the owner
 * actually saw and comes back stale instead of silently overwriting the newer row. Props older than the
 * draft (a refresh that started before the owner's own save landed) are never adopted.
 */
export function rebaseDraft<F>(draft: EditorDraft<F>, latestVersion: number, latestForm: () => F): EditorDraft<F> {
  if (latestVersion <= draft.baseVersion) return draft;
  if (isDraftDirty(draft)) return draft;
  return openDraft(latestForm(), latestVersion);
}
