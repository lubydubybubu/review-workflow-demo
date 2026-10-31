'use client';

import { useEffect, useId, useRef, useState, useTransition } from 'react';
import ReactMarkdown from 'react-markdown';
import { Dot, OverdueTag } from '@/components/badges';
import { useToast } from '@/components/toast';
import { NotStoredNotice } from '@/components/unsaved-guard';
import { diffDays, formatDateShort, type IsoDate } from '@/lib/domain/dates';
import { overdueFields } from '@/lib/domain/overdue';
import {
  CALENDAR_FIELD_META,
  CATEGORY_KEYS,
  CATEGORY_LABEL,
  CHANNEL_LABEL,
  CHANNELS,
  PRIORITIES,
  PRIORITY_LABEL,
  SOURCE_TYPE_LABEL,
  SOURCE_TYPES,
  type Stage,
} from '@/lib/domain/review';
import { draftKey, useDraftGuard } from '@/lib/draft-guard';
import { isDraftDirty } from '@/lib/editor-draft';
import { useGuardedRouter } from '@/lib/unsaved';
import {
  initialReviewEditor,
  rebaseReviewEditor,
  REVIEW_STALE_MESSAGE,
  toReviewForm,
  type ReviewEditorState,
  type ReviewFormState as FormState,
} from '@/lib/review-form';
import { setReviewArchivedAction, updateReviewAction } from '@/server/actions/reviews';
import type { ReviewDetail } from '@/server/db/reviews';

/**
 * The whole review as one form. Changing the stage saves immediately. The draft and the version it is saved
 * against live in ONE state value (`ReviewEditorState`), never remounted by a refresh: a background refresh
 * (a task/checklist action's revalidation, router.refresh) may replace both together only while the form is
 * untouched (`rebaseReviewEditor`); with unsaved changes it keeps both, says the review changed elsewhere,
 * and a save comes back stale instead of overwriting. A successful own save adopts the stored row and its
 * version; only the owner's explicit "최신 내용 불러오기" or "버리기" drops a draft. Leaving the page does not:
 * the draft and its version are kept for this tab and restored on return (`useDraftGuard`); if the browser could
 * not store it, leaving asks first (`@/lib/unsaved`).
 */
export function ReviewEditor({
  review,
  stages,
  brands,
  today,
}: {
  review: ReviewDetail;
  stages: Stage[];
  brands: { id: number; name: string }[];
  today: IsoDate;
}) {
  const router = useGuardedRouter();
  const toast = useToast();
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, setState] = useState<ReviewEditorState>(() => initialReviewEditor(review));
  const [seen, setSeen] = useState(review);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notesTab, setNotesTab] = useState<'edit' | 'preview'>(review.notesMd ? 'preview' : 'edit');
  const [pending, startTransition] = useTransition();

  // A new `review` prop (revalidation after any action, router.refresh): adjust state during render.
  if (seen !== review) {
    setSeen(review);
    setState((s) => rebaseReviewEditor(s, review));
  }

  // leaving with unsaved changes (link, Back, reload) keeps them for this tab; see draft-guard
  const { restored, dismissRestored, notStored } = useDraftGuard({
    storageKey: draftKey('review', review.id),
    label: '리뷰 편집',
    href: `/reviews/${review.id}`,
    draft: state,
    template: toReviewForm(review),
    restore: setState,
    discard: () => setState(initialReviewEditor(review)),
  });

  const { form, baseVersion } = state;
  const archived = review.archivedAt !== null;
  const dirty = isDraftDirty(state);
  // a newer review arrived while there are unsaved changes (a clean form would have followed it)
  const stale = review.version > baseVersion;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setState((s) => ({ ...s, form: { ...s.form, [key]: value } }));
  const late = archived ? [] : overdueFields(review, today);
  const embargoWarning =
    form.embargoUntil && form.publishPlannedOn && form.publishPlannedOn < form.embargoUntil
      ? `발행 예정일이 엠바고(${formatDateShort(form.embargoUntil, today)}) 전입니다.`
      : null;

  function save(submitted: FormState = form) {
    setErrors({});
    startTransition(async () => {
      const result = await updateReviewAction(review.id, submitted, baseVersion);
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast(result.error, { tone: 'error' });
        // brings the newer row (and with it the notice below); the draft and its old version stay as they are
        if (result.error === REVIEW_STALE_MESSAGE) router.refresh();
        return;
      }
      setState(initialReviewEditor(result.data.review)); // stored values + their version, together
      toast('저장했습니다.');
    });
  }

  // Ctrl/Cmd+S saves from anywhere on the page.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (formRef.current?.reportValidity()) saveRef.current();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function archive(next: boolean) {
    startTransition(async () => {
      const result = await setReviewArchivedAction(review.id, next);
      if (!result.ok) {
        toast(result.error, { tone: 'error' });
        return;
      }
      if (next) {
        toast(`‘${review.productName}’을(를) 보관했습니다.`, {
          action: { label: '되돌리기', onClick: () => void setReviewArchivedAction(review.id, false).then(() => router.push(`/reviews/${review.id}`)) },
        });
        router.push('/reviews');
      } else {
        toast('보관을 해제했습니다.');
      }
    });
  }

  const field = (name: keyof FormState) => ({
    id: `${uid}-${name}`,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name] ? `${uid}-${name}-error` : undefined,
  });
  const error = (name: keyof FormState) =>
    errors[name] ? (
      <p id={`${uid}-${name}-error`} className="mt-1 text-[12px] text-danger">
        {errors[name]}
      </p>
    ) : null;
  const dateInput = (name: keyof FormState, label: string, extra?: React.ReactNode) => (
    <div>
      <label htmlFor={`${uid}-${name}`} className="label">
        {label}
      </label>
      <input
        type="date"
        className="input"
        {...field(name)}
        value={form[name] as string}
        onChange={(e) => set(name, e.target.value as never)}
      />
      {error(name)}
      {extra}
    </div>
  );

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      aria-label="리뷰 편집"
      className="min-w-0"
    >
      {archived ? (
        <div role="status" className="mb-4 flex items-center justify-between gap-3 rounded-md border border-line bg-hover px-3 py-2 text-[13px]">
          보관된 리뷰입니다. 보드·캘린더에 나오지 않습니다.
          <button type="button" className="btn h-8" onClick={() => archive(false)}>
            보관 해제
          </button>
        </div>
      ) : null}
      {stale ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {REVIEW_STALE_MESSAGE} 작성 중인 내용은 아직 이 화면에 남아 있습니다.
          <button type="button" className="btn h-8" onClick={() => setState(initialReviewEditor(review))}>
            최신 내용 불러오기 (내 변경 버리기)
          </button>
        </div>
      ) : null}
      {restored ? (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-hover px-3 py-2 text-[13px]">
          저장하지 않은 초안을 복원했습니다.
          <button
            type="button"
            className="btn h-8"
            onClick={() => {
              dismissRestored();
              setState(initialReviewEditor(review));
            }}
          >
            버리기
          </button>
        </div>
      ) : null}
      {notStored ? <NotStoredNotice /> : null}

      <fieldset disabled={archived || pending} className="min-w-0">
        <label htmlFor={`${uid}-productName`} className="sr-only">
          제품명
        </label>
        <input
          {...field('productName')}
          className="w-full bg-transparent text-[24px] leading-tight font-bold tracking-tight outline-none placeholder:text-subtle md:text-[28px]"
          required
          maxLength={200}
          value={form.productName}
          onChange={(e) => set('productName', e.target.value)}
        />
        {error('productName')}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor={`${uid}-stageId`} className="sr-only">
            단계
          </label>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line pl-2.5">
            <Dot color={stages.find((s) => String(s.id) === form.stageId)?.color ?? 'var(--subtle)'} />
            <select
              {...field('stageId')}
              className="h-8 bg-transparent pr-2 text-[13px] font-medium outline-none"
              value={form.stageId}
              onChange={(e) => {
                const next = { ...form, stageId: e.target.value };
                setState((s) => ({ ...s, form: next }));
                save(next);
              }}
            >
              {CATEGORY_KEYS.map((c) => (
                <optgroup key={c} label={CATEGORY_LABEL[c]}>
                  {stages
                    .filter((s) => s.categoryKey === c)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </span>
          {late.map((f) => {
            const date = f === 'write_due' ? review.writeDueOn! : review.publishPlannedOn!;
            return (
              <OverdueTag key={f}>
                {CALENDAR_FIELD_META[f].label} {diffDays(date, today)}일 지남
              </OverdueTag>
            );
          })}
          <span className="ml-auto flex items-center gap-2">
            {dirty ? <span className="text-[12px] text-muted">저장하지 않은 변경</span> : null}
            {archived ? null : (
              <button type="button" className="btn btn-ghost text-muted" onClick={() => archive(true)}>
                보관
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={!dirty || pending}>
              {pending ? '저장 중…' : '저장'}
            </button>
          </span>
        </div>

        <section aria-labelledby={`${uid}-basic`} className="mt-8">
          <h2 id={`${uid}-basic`} className="section-title">
            기본 정보
          </h2>
          <div className="grid gap-4 pt-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-title`} className="label">
                작업 제목 (영상·글)
              </label>
              <input
                {...field('title')}
                className="input"
                maxLength={200}
                placeholder="예: 한 달 써 보고 느낀 점"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
              />
              {error('title')}
            </div>
            <div>
              <label htmlFor={`${uid}-brandId`} className="label">
                브랜드
              </label>
              <select {...field('brandId')} className="input" value={form.brandId} onChange={(e) => set('brandId', e.target.value)}>
                <option value="">없음</option>
                {brands.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
                {review.brandId && !brands.some((b) => b.id === review.brandId) ? (
                  <option value={review.brandId}>{review.brandName} (보관됨)</option>
                ) : null}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${uid}-sourceType`} className="label">
                  입수 형태
                </label>
                <select
                  {...field('sourceType')}
                  className="input"
                  value={form.sourceType}
                  onChange={(e) => set('sourceType', e.target.value)}
                >
                  <option value="">미정</option>
                  {SOURCE_TYPES.map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_TYPE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor={`${uid}-priority`} className="label">
                  우선순위
                </label>
                <select {...field('priority')} className="input" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="label">채널</legend>
              <div className="flex flex-wrap gap-1.5">
                {CHANNELS.map((c) => {
                  const on = form.channels.includes(c);
                  return (
                    <label
                      key={c}
                      className={`inline-flex h-8 cursor-pointer items-center rounded-full border px-3 text-[12px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent ${
                        on ? 'border-fg font-medium' : 'border-line text-muted'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={on}
                        onChange={() =>
                          set('channels', on ? form.channels.filter((x) => x !== c) : CHANNELS.filter((x) => x === c || form.channels.includes(x)))
                        }
                      />
                      {CHANNEL_LABEL[c]}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          </div>
        </section>

        <section aria-labelledby={`${uid}-dates`} className="mt-8">
          <h2 id={`${uid}-dates`} className="section-title">
            일정
          </h2>
          <div className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
            {dateInput('receivedOn', '입고일')}
            {dateInput('shootOn', '촬영일')}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={`${uid}-shootStartTime`} className="label">
                  촬영 시작
                </label>
                <input
                  type="time"
                  className="input"
                  {...field('shootStartTime')}
                  value={form.shootStartTime}
                  onChange={(e) => set('shootStartTime', e.target.value)}
                />
                {error('shootStartTime')}
              </div>
              <div>
                <label htmlFor={`${uid}-shootEndTime`} className="label">
                  종료
                </label>
                <input
                  type="time"
                  className="input"
                  {...field('shootEndTime')}
                  value={form.shootEndTime}
                  onChange={(e) => set('shootEndTime', e.target.value)}
                />
                {error('shootEndTime')}
              </div>
            </div>
            {dateInput('writeDueOn', '작성 마감')}
            {dateInput(
              'publishPlannedOn',
              '발행 예정',
              embargoWarning ? <p className="mt-1 text-[12px] text-warn">{embargoWarning}</p> : null,
            )}
            {dateInput('embargoUntil', '엠바고 (이 날짜 전 발행 금지)')}
            <div>
              <label htmlFor={`${uid}-publishedAtLocal`} className="label">
                실제 발행
              </label>
              <input
                type="datetime-local"
                className="input"
                {...field('publishedAtLocal')}
                value={form.publishedAtLocal}
                onChange={(e) => set('publishedAtLocal', e.target.value)}
              />
              {error('publishedAtLocal')}
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`${uid}-publishedUrl`} className="label">
                발행 주소
              </label>
              <input
                type="url"
                className="input"
                placeholder="https://"
                {...field('publishedUrl')}
                value={form.publishedUrl}
                onChange={(e) => set('publishedUrl', e.target.value)}
              />
              {error('publishedUrl')}
            </div>
          </div>
        </section>

        <section aria-labelledby={`${uid}-notes`} className="mt-8">
          <h2 id={`${uid}-notes`} className="section-title">
            메모
            <span role="tablist" aria-label="메모 보기" className="flex gap-3 text-[12px] font-normal">
              {(['edit', 'preview'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={notesTab === tab}
                  className={notesTab === tab ? 'font-semibold text-fg' : 'text-muted hover:text-fg'}
                  onClick={() => setNotesTab(tab)}
                >
                  {tab === 'edit' ? '편집' : '미리보기'}
                </button>
              ))}
            </span>
          </h2>
          <div className="pt-3">
            {notesTab === 'edit' ? (
              <>
                <label htmlFor={`${uid}-notesMd`} className="sr-only">
                  메모 (마크다운)
                </label>
                <textarea
                  {...field('notesMd')}
                  className="input min-h-56 font-mono text-[13px]"
                  placeholder="마크다운으로 적습니다. 예: ## 핵심 포인트"
                  value={form.notesMd}
                  onChange={(e) => set('notesMd', e.target.value)}
                />
              </>
            ) : (
              <div className="prose-ops min-h-24 text-[14px]">
                {form.notesMd.trim() ? <ReactMarkdown>{form.notesMd}</ReactMarkdown> : <p className="text-muted">메모가 없습니다.</p>}
              </div>
            )}
          </div>
        </section>
      </fieldset>
    </form>
  );
}
