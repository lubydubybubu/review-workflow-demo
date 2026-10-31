'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { forgetDraft, sessionStore } from '@/lib/draft-guard';
import { readRecovery, writeRecovery } from '@/lib/recovery';
import { UnsavedContext, type RecoveryEntry, type UnsavedRegistry } from '@/lib/unsaved';

/**
 * The app's one boundary for unsaved input (`@/lib/unsaved`): provides the registry, asks before an in-app link
 * leaves a page that would lose input (one capture-phase listener for every link, so no link needs its own
 * check), keeps the browser's unload prompt on while anything is unsaved, and shows the question. It also
 * carries unsaved input across a sign-in (`@/lib/recovery`) for `owner` (the signed-in owner's tag).
 */
export function UnsavedGuard({ registry, owner, children }: { registry: UnsavedRegistry; owner: string; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  // On mount: offer what an ended session left behind (this owner only); keep the unsettled ones stored. On
  // unmount — the session ended and the server sent the tab to /login, outside this shell — carry everything
  // still unsaved. A layout-effect cleanup: it runs before any form's own cleanup unregisters it.
  useLayoutEffect(() => {
    registry.offer(readRecovery(sessionStore(), owner));
    const unsubscribe = registry.subscribe(() => writeRecovery(sessionStore(), owner, registry.pendingRecovery()));
    return () => {
      unsubscribe();
      writeRecovery(sessionStore(), owner, registry.recoverable());
    };
  }, [registry, owner]);

  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!registry.hasUnsaved()) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [registry]);

  // Runs before any link's own click handler (capture, on the document): a plain click on a same-origin link to
  // another page is held while that would lose input. Links that open the peek instead of navigating, new-tab /
  // download / external links (the unload prompt covers those) pass.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!a || a.hasAttribute('download') || a.hasAttribute('data-peek-link') || (a.target && a.target !== '_self')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (registry.blockers('route').length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      registry.request('route', '이동', () => router.push(`${url.pathname}${url.search}${url.hash}`));
    }
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [registry, router]);

  // The page changed under an open question (browser Back / Forward cannot be held): keep everything.
  useEffect(() => registry.cancel(), [registry, pathname]);

  return (
    <UnsavedContext.Provider value={registry}>
      {children}
      <UnsavedQuestion registry={registry} />
    </UnsavedContext.Provider>
  );
}

function UnsavedQuestion({ registry }: { registry: UnsavedRegistry }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const pending = registry.pending;
  const ref = useRef<HTMLDialogElement>(null);
  const uid = useId();

  // opened after whatever is showing, so it is on top of it (a creation dialog, the palette)
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    if (!pending && dialog.open) dialog.close();
  }, [pending]);

  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={`${uid}-title`}
      aria-describedby={`${uid}-body`}
      tabIndex={-1}
      // Esc = 계속 편집 (handled here: the browser's own close request cannot always be cancelled)
      closedby="none"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
        e.preventDefault();
        registry.cancel();
      }}
      onCancel={(e) => {
        e.preventDefault();
        registry.cancel();
      }}
      // only a close by the browser itself means 계속 편집: the `close` event of our own close() arrives later, when
      // the next question may already be showing
      onClose={() => {
        if (!ref.current?.open) registry.cancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) registry.cancel();
      }}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-line-strong bg-bg p-0 text-fg outline-none backdrop:backdrop-blur-[1px]"
    >
      {pending ? (
        <div className="flex flex-col gap-3 p-5">
          <h2 id={`${uid}-title`} className="text-[15px] font-semibold">
            저장하지 않은 변경이 있습니다
          </h2>
          <div id={`${uid}-body`} className="flex flex-col gap-2 text-[13px]">
            <ul className="list-disc pl-5" data-testid="unsaved-owners">
              {pending.blockers.map((b, i) => (
                <li key={i}>
                  {b.label}
                  {b.note ? <span className="text-danger"> — {b.note}</span> : null}
                </li>
              ))}
            </ul>
            <p className="text-muted">계속하면 이 입력은 사라집니다. 저장되는 것은 없습니다.</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-line pt-4">
            <button type="button" className="btn" autoFocus onClick={() => registry.cancel()}>
              계속 편집
            </button>
            <button type="button" className="btn border-danger/40 text-danger" onClick={() => registry.accept()}>
              버리고 {pending.action}
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** In an editor whose draft the browser could not store: what that means for leaving. */
export function NotStoredNotice() {
  return (
    <div role="alert" data-testid="draft-not-stored" className="mb-4 rounded-md border border-warn/50 px-3 py-2 text-[13px] text-warn">
      작성 중인 내용을 이 탭의 저장 공간에 보관하지 못했습니다(공간 부족 또는 차단). 다른 화면으로 이동하기 전에
      확인을 묻고, 새로 고침하거나 탭을 닫으면 사라집니다.
    </div>
  );
}

/**
 * After a sign-in: the unsaved inputs an ended session left behind, each to restore into its form (`onRestore`
 * opens it there; it keeps the version it was edited against) or to drop. Nothing is saved either way.
 */
export function RecoveryOffer({ registry, onRestore }: { registry: UnsavedRegistry; onRestore: (entry: RecoveryEntry) => void }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const uid = useId();
  const entries = registry.pendingRecovery();
  if (entries.length === 0) return null;
  return (
    <section aria-labelledby={`${uid}-title`} data-testid="recovery-offer" className="mb-4 rounded-md border border-warn/50 px-3 py-2 text-[13px]">
      <h2 id={`${uid}-title`} className="font-semibold text-warn">
        저장하지 않은 입력 복원
      </h2>
      <p className="mt-0.5 text-muted">
        로그인이 끝나 화면이 닫히기 전의 입력을 이 탭에 보관했습니다. 복원하면 그 화면에 다시 채워지고, 저장은 직접 해야 합니다.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {entries.map((e) => (
          <li key={e.key} data-recovery-key={e.key} className="flex flex-wrap items-center gap-2">
            <span className="mr-auto font-medium">{e.label}</span>
            <button type="button" className="btn h-7 px-2.5" onClick={() => onRestore(e)}>
              복원
            </button>
            <button
              type="button"
              className="btn h-7 border-danger/40 px-2.5 text-danger"
              onClick={() => {
                registry.dropCarried(e.key);
                forgetDraft(sessionStore(), e.key);
              }}
            >
              버리기
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Drafts kept only in this tab's memory whose editor is not open (left by browser Back / Forward). */
export function KeptAwayNotice({ registry }: { registry: UnsavedRegistry }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion, registry.getVersion);
  const away = registry.keptAway();
  if (away.length === 0) return null;
  return (
    <div role="alert" data-testid="drafts-kept-away" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warn/50 px-3 py-2 text-[13px] text-warn">
      <span>저장하지 않은 초안이 이 탭에만 남아 있습니다. 새로 고침하거나 탭을 닫으면 사라집니다.</span>
      {away.map((k) => (
        <Link key={k.key} href={k.href} className="font-semibold underline underline-offset-2">
          {k.label} 열기
        </Link>
      ))}
    </div>
  );
}
