'use client';

/** The task pages could not load (database unreachable, etc.): say so in Korean and offer a retry; no internals. */
export default function TasksError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div role="alert" className="max-w-xl rounded-md border border-line px-4 py-5">
      <h1 className="text-[16px] font-semibold">할 일을 불러오지 못했습니다.</h1>
      <p className="mt-1 text-[13px] text-muted">잠시 후 다시 시도해 주세요. 작성 중이던 내용은 저장되지 않았을 수 있습니다.</p>
      <button type="button" className="btn mt-4" onClick={reset}>
        다시 시도
      </button>
    </div>
  );
}
