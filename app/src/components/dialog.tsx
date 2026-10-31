'use client';

import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { useUnsavedRegistry } from '@/lib/unsaved';

const noSubscribe = () => () => {};

/** Runs `close`, or first asks (e.g. about unsaved input in the dialog). */
type DismissGuard = (close: () => void) => void;
const DismissContext = createContext<((guard: DismissGuard | null) => void) | null>(null);

/**
 * For a form inside a `Dialog`: its Esc / backdrop dismissal goes through `guard` (e.g. `confirm` from
 * `useUnsavedOwner`, which asks while the form holds unsaved input).
 */
export function useDialogDismiss(guard: DismissGuard): void {
  const set = useContext(DismissContext);
  const current = useRef(guard);
  useEffect(() => {
    current.current = guard;
  });
  useEffect(() => {
    if (!set) return;
    set((close) => current.current(close));
    return () => set(null);
  }, [set]);
}

/**
 * Thin wrapper over the native <dialog>: modal focus trapping and the top layer come from the browser.
 * Esc and a backdrop click ask the owner to close it (`onClose`) rather than closing it outright, so a dialog
 * holding unsaved input can stay open (see `@/lib/unsaved`). If a browser closes it anyway (where `closedby` is
 * unsupported, an Esc without recent user activation is not cancelable), it is shown again while it is still meant
 * to be open — but not over an open unsaved-changes question (then once that is answered).
 */
export function Dialog({
  open,
  onClose,
  label,
  className = '',
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const meantOpen = useRef(open);
  const [, reshow] = useReducer((n: number) => n + 1, 0);
  const unsaved = useUnsavedRegistry();
  const asking = useSyncExternalStore(unsaved?.subscribe ?? noSubscribe, () => unsaved?.asking() ?? false, () => false);
  const guard = useRef<DismissGuard | null>(null);
  const setGuard = useCallback((g: DismissGuard | null) => {
    guard.current = g;
  }, []);
  const dismiss = useRef(() => {});
  useEffect(() => {
    dismiss.current = () => (guard.current ? guard.current(onClose) : onClose());
  });

  // Re-sync after every render.
  useEffect(() => {
    meantOpen.current = open;
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open && !asking) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  });

  // Esc while focus is in no dialog at all — e.g. the focused button was disabled while saving and the browser
  // moved focus to the page: the key never reaches the dialog's own handler (and with `closedby="none"` the
  // browser does nothing either). Only for the single open modal dialog; before any page-wide Esc handler.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      const dialog = ref.current;
      if (!dialog?.open || (e.target instanceof Element && e.target.closest('dialog'))) return;
      try {
        if (!dialog.matches(':modal') || document.querySelectorAll('dialog:modal').length !== 1) return;
      } catch {
        return; // no :modal support
      }
      e.preventDefault();
      e.stopPropagation();
      dismiss.current();
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      // a click on its plain text keeps focus inside, so Esc (below) still reaches it
      tabIndex={-1}
      // Esc is ours (below): the browser's own close request cannot always be cancelled
      closedby="none"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        dismiss.current();
      }}
      // browsers without `closedby`: their Esc arrives as `cancel` (and may close it anyway, see onClose)
      onCancel={(e) => {
        e.preventDefault();
        dismiss.current();
      }}
      // closed by the browser itself after an Esc it would not let us cancel: that Esc already asked (onCancel)
      onClose={() => {
        if (meantOpen.current && !ref.current?.open) reshow();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss.current();
      }}
      className={`m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border border-line-strong bg-bg p-0 text-fg outline-none backdrop:backdrop-blur-[1px] ${className}`}
    >
      <DismissContext.Provider value={setGuard}>{open ? children : null}</DismissContext.Provider>
    </dialog>
  );
}
