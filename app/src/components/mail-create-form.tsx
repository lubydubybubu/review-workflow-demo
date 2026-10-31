'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CATEGORY_LABEL, SOURCE_TYPE_LABEL, SOURCE_TYPES, type SourceType, type Stage } from '@/lib/domain/review';
import { matchBrand } from '@/lib/mail';
import { carriedForm } from '@/lib/recovery';
import { useUnsavedOwner } from '@/lib/unsaved';
import { acceptMailCandidateAction } from '@/server/actions/mail';
import { OPS_EVENTS, useShell, type MailPrefill } from './shell-context';
import { useToast } from './toast';

const NEW_BRAND = 'new';

interface FormState {
  productName: string;
  /** a brand id, '' (none) or NEW_BRAND */
  brand: string;
  newBrandName: string;
  sourceType: SourceType | '';
  templateId: string;
  writeDueOn: string;
  publishPlannedOn: string;
  embargoUntil: string;
  memo: string;
}

/** Same rule as the server (mailIntakeStage): the default stage when it is a to-do stage, else the first to-do stage. */
function intakeStage(stages: Stage[]): Stage | undefined {
  return stages.find((s) => s.isDefault && s.categoryKey === 'todo') ?? stages.find((s) => s.categoryKey === 'todo');
}

/**
 * Quick create, opened from a mail candidate (리뷰로 등록): the extracted fields prefilled for the owner
 * to check. Saving creates the review in the 받음 stage and marks the candidate accepted in one
 * transaction on the server. Mail text only ever lands in form values (plain text).
 */
export function MailCreateForm({ prefill, onClose, onDone }: { prefill: MailPrefill; onClose: () => void; onDone: () => void }) {
  const { stages, templates, brands } = useShell();
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const matched = matchBrand(brands, prefill.brandName);
  const pathname = usePathname();
  const [initial, setInitial] = useState<FormState>(() => ({
    productName: prefill.productName,
    brand: matched ? String(matched.id) : prefill.brandName?.trim() ? NEW_BRAND : '',
    newBrandName: matched ? '' : (prefill.brandName?.trim() ?? ''),
    sourceType: prefill.sourceType ?? '',
    templateId: String(templates.find((t) => prefill.sourceType && t.sourceType === prefill.sourceType)?.id ?? ''),
    writeDueOn: prefill.writeDueOn ?? '',
    publishPlannedOn: prefill.publishPlannedOn ?? '',
    embargoUntil: prefill.embargoUntil ?? '',
    memo: prefill.memo,
  }));
  const [form, setForm] = useState<FormState>(initial);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));
  const stage = intakeStage(stages);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  // the owner's corrections exist only here until 리뷰로 등록 (the candidate row is untouched): replacing or
  // dismissing the dialog with corrections in it asks first. An ended session carries them, with the candidate
  // and the version the inbox showed (the prefill), so a restored registration is still refused if the
  // candidate was decided meanwhile.
  useUnsavedOwner({
    label: '메일 의뢰 등록',
    scope: 'overlay',
    dirty,
    discard: onDone,
    recovery: {
      key: `mail-register:${prefill.candidateId}`,
      href: pathname,
      open: { kind: 'create', prefill: { mail: prefill } },
      data: dirty ? { initial, form } : undefined,
      restore: (data) => {
        const carried = carriedForm(data, initial, { productName: 200, newBrandName: 120, memo: 2000 });
        if (!carried) return;
        setInitial(carried.initial);
        setForm(carried.form);
      },
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await acceptMailCandidateAction(prefill.candidateId, prefill.version, {
        productName: form.productName,
        brandId: form.brand === NEW_BRAND ? '' : form.brand,
        newBrandName: form.brand === NEW_BRAND ? form.newBrandName : '',
        sourceType: form.sourceType,
        templateId: form.templateId,
        writeDueOn: form.writeDueOn,
        publishPlannedOn: form.publishPlannedOn,
        embargoUntil: form.embargoUntil,
        memo: form.memo,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone();
      window.dispatchEvent(new Event(OPS_EVENTS.reviewsChanged));
      router.refresh();
      toast(`‘${form.productName.trim()}’ 리뷰를 ${stage?.name ?? '받음'} 단계로 등록했습니다.`, {
        action: { label: '열기', href: `/reviews/${result.data.reviewId}` },
      });
    });
  }

  return (
    <form onSubmit={submit} className="flex max-h-[85dvh] flex-col gap-4 overflow-y-auto p-5" aria-label="메일 의뢰를 리뷰로 등록">
      <div>
        <h2 className="text-[15px] font-semibold">메일 의뢰를 리뷰로 등록</h2>
        <p className="mt-0.5 truncate text-[12px] text-muted" title={prefill.subject}>
          {prefill.sender} · {prefill.subject || '(제목 없음)'}
        </p>
      </div>

      <div>
        <label htmlFor="mc-product" className="label">
          제품명
        </label>
        <input
          id="mc-product"
          className="input"
          autoFocus
          autoComplete="off"
          required
          maxLength={200}
          placeholder="메일에서 제품명을 찾지 못했습니다"
          value={form.productName}
          onChange={(e) => set('productName', e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={form.brand === NEW_BRAND ? 'col-span-2 grid grid-cols-2 gap-3' : ''}>
          <div>
            <label htmlFor="mc-brand" className="label">
              브랜드
            </label>
            <select id="mc-brand" className="input" value={form.brand} onChange={(e) => set('brand', e.target.value)}>
              <option value="">없음</option>
              <option value={NEW_BRAND}>새 브랜드 만들기</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          {form.brand === NEW_BRAND ? (
            <div>
              <label htmlFor="mc-new-brand" className="label">
                새 브랜드 이름
              </label>
              <input
                id="mc-new-brand"
                className="input"
                required
                maxLength={120}
                value={form.newBrandName}
                onChange={(e) => set('newBrandName', e.target.value)}
              />
            </div>
          ) : null}
        </div>
        <div>
          <label htmlFor="mc-source" className="label">
            입수 형태
          </label>
          <select id="mc-source" className="input" value={form.sourceType} onChange={(e) => set('sourceType', e.target.value as SourceType | '')}>
            <option value="">미정</option>
            {SOURCE_TYPES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_TYPE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mc-template" className="label">
            템플릿 (체크리스트)
          </label>
          <select id="mc-template" className="input" value={form.templateId} onChange={(e) => set('templateId', e.target.value)}>
            <option value="">없음</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mc-write" className="label">
            작성 마감
          </label>
          <input id="mc-write" type="date" className="input" value={form.writeDueOn} onChange={(e) => set('writeDueOn', e.target.value)} />
        </div>
        <div>
          <label htmlFor="mc-publish" className="label">
            발행 예정
          </label>
          <input
            id="mc-publish"
            type="date"
            className="input"
            value={form.publishPlannedOn}
            onChange={(e) => set('publishPlannedOn', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="mc-embargo" className="label">
            엠바고
          </label>
          <input id="mc-embargo" type="date" className="input" value={form.embargoUntil} onChange={(e) => set('embargoUntil', e.target.value)} />
        </div>
        <div>
          <span className="label">단계</span>
          <p className="flex h-9 items-center text-[13px]" data-testid="mc-stage">
            {stage ? `${stage.name} (${CATEGORY_LABEL[stage.categoryKey]})` : '할 일'}
          </p>
        </div>
      </div>

      <div>
        <label htmlFor="mc-memo" className="label">
          메모 (리뷰 메모에 글자 그대로 들어갑니다)
        </label>
        <textarea id="mc-memo" className="input" rows={3} maxLength={2000} value={form.memo} onChange={(e) => set('memo', e.target.value)} />
      </div>

      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          취소
        </button>
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? '등록 중…' : '리뷰로 등록'}
        </button>
      </div>
    </form>
  );
}
