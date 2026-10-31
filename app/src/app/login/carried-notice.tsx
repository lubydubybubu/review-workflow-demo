'use client';

import { useSyncExternalStore } from 'react';
import { sessionStore } from '@/lib/draft-guard';
import { carriedCount } from '@/lib/recovery';

const noSubscribe = () => () => {};

/** Unsaved input an ended session left in this tab (`@/lib/recovery`): offered again after signing in here. */
export function CarriedNotice() {
  const count = useSyncExternalStore(noSubscribe, () => carriedCount(sessionStore()), () => 0);
  if (count === 0) return null;
  return (
    <p role="status" data-testid="carried-notice" className="mb-4 rounded-md border border-warn/50 px-3 py-2 text-[13px] text-warn">
      저장하지 않은 입력 {count}개를 이 탭에 보관했습니다. 이 탭에서 다시 로그인하면 복원하거나 버릴 수 있습니다.
    </p>
  );
}
