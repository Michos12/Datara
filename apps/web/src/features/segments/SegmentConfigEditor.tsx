import {
  segmentConfigSchema,
  segmentConfigVersionSchema,
  segmentPreviewResponseSchema,
  uncoveredCells,
  type SegmentConfig,
  type SegmentConfigVersion,
  type SegmentPreviewResponse,
} from '@ci/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, SelectField, TextField } from '../../components/forms';
import { Card } from '../../components/PageHeader';
import { ApiError, apiRequest } from '../../lib/api';
import { formatNumber } from '../../lib/format';

const SCORES = [1, 2, 3, 4, 5];

function RangeSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number];
  onChange: (value: [number, number]) => void;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <select
        aria-label={`${label} min`}
        className="rounded border border-line bg-surface px-1 py-0.5 text-xs"
        value={value[0]}
        onChange={(e) =>
          onChange([Number(e.target.value), Math.max(Number(e.target.value), value[1])])
        }
      >
        {SCORES.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <span className="text-ink-subtle">–</span>
      <select
        aria-label={`${label} max`}
        className="rounded border border-line bg-surface px-1 py-0.5 text-xs"
        value={value[1]}
        onChange={(e) =>
          onChange([Math.min(value[0], Number(e.target.value)), Number(e.target.value)])
        }
      >
        {SCORES.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
    </div>
  );
}

/** Edits segment rules and scoring, previews the result, and saves a new version. */
export function SegmentConfigEditor({
  current,
  onClose,
}: {
  current: SegmentConfigVersion;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SegmentConfig>(current.config);
  const [preview, setPreview] = useState<SegmentPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const missing = uncoveredCells(draft.rules);
  const updateRule = (index: number, patch: Partial<SegmentConfig['rules'][number]>) =>
    setDraft((d) => ({
      ...d,
      rules: d.rules.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  const moveRule = (index: number, delta: number) =>
    setDraft((d) => {
      const rules = [...d.rules];
      const [rule] = rules.splice(index, 1);
      rules.splice(index + delta, 0, rule!);
      return { ...d, rules };
    });

  function validated(): SegmentConfig | null {
    const parsed = segmentConfigSchema.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('errors.generic'));
      return null;
    }
    setError(null);
    return parsed.data;
  }

  async function run(action: () => Promise<void>) {
    setPending(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
    } finally {
      setPending(false);
    }
  }

  const doPreview = () => {
    const config = validated();
    if (config)
      void run(async () =>
        setPreview(
          await apiRequest('POST', '/segments/config/preview', {
            body: { config },
            schema: segmentPreviewResponseSchema,
          }),
        ),
      );
  };

  const save = () => {
    const config = validated();
    if (config)
      void run(async () => {
        await apiRequest('POST', '/segments/config', {
          body: { config, activate: true },
          schema: segmentConfigVersionSchema,
        });
        await queryClient.invalidateQueries({ queryKey: ['segments'] });
        await queryClient.invalidateQueries({ queryKey: ['analytics', 'status'] });
        onClose();
      });
  };

  return (
    <Card>
      <h2 className="text-sm font-semibold">
        {t('segments.editorTitle', { version: current.version })}
      </h2>
      <p className="mt-1 text-xs text-ink-muted">{t('segments.editorHint')}</p>

      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <TextField
          label={t('segments.lookback')}
          type="number"
          min={30}
          value={draft.lookbackDays}
          onChange={(e) => setDraft((d) => ({ ...d, lookbackDays: Number(e.target.value) }))}
        />
        {(['recency', 'frequency', 'monetary'] as const).map((dimension) => (
          <SelectField
            key={dimension}
            label={t(`segments.scoring.${dimension}`)}
            value={draft.scoring[dimension]}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                scoring: { ...d.scoring, [dimension]: e.target.value as 'thresholds' | 'quintile' },
                ...(dimension === 'monetary' &&
                e.target.value === 'thresholds' &&
                !d.monetaryThresholds
                  ? {
                      monetaryThresholds: [1000, 5000, 20000, 50000] as [
                        number,
                        number,
                        number,
                        number,
                      ],
                    }
                  : {}),
              }))
            }
            options={[
              { value: 'thresholds', label: t('segments.methods.thresholds') },
              { value: 'quintile', label: t('segments.methods.quintile') },
            ]}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-subtle">
        {t('segments.thresholdsHint', { thresholds: draft.frequencyThresholds.join(' / ') })}
      </p>

      <div className="mt-4 overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('segments.order')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                {t('segments.segment')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                R
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                F
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                M
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t('segments.preview')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {draft.rules.map((rule, i) => (
              <tr key={rule.key}>
                <td className="whitespace-nowrap px-3 py-2">
                  <button
                    type="button"
                    className="px-1 disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => moveRule(i, -1)}
                    aria-label={t('segments.moveUp', { name: rule.name })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="px-1 disabled:opacity-30"
                    disabled={i === draft.rules.length - 1}
                    onClick={() => moveRule(i, 1)}
                    aria-label={t('segments.moveDown', { name: rule.name })}
                  >
                    ↓
                  </button>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      aria-label={t('segments.colorOf', { name: rule.name })}
                      value={rule.color}
                      onChange={(e) => updateRule(i, { color: e.target.value })}
                      className="size-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                    <input
                      aria-label={t('segments.nameOf', { key: rule.key })}
                      value={rule.name}
                      onChange={(e) => updateRule(i, { name: e.target.value })}
                      className="w-40 rounded border border-line bg-surface px-2 py-1"
                    />
                  </div>
                </td>
                <td className="px-3 py-2">
                  <RangeSelect
                    label={`${rule.name} R`}
                    value={rule.r}
                    onChange={(r) => updateRule(i, { r })}
                  />
                </td>
                <td className="px-3 py-2">
                  <RangeSelect
                    label={`${rule.name} F`}
                    value={rule.f}
                    onChange={(f) => updateRule(i, { f })}
                  />
                </td>
                <td className="px-3 py-2">
                  {rule.m ? (
                    <RangeSelect
                      label={`${rule.name} M`}
                      value={rule.m}
                      onChange={(m) => updateRule(i, { m })}
                    />
                  ) : (
                    <span className="text-ink-subtle">{t('segments.any')}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {preview ? formatNumber(preview.counts[rule.key] ?? 0) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {missing.length > 0 && (
        <div className="mt-3">
          <Alert tone="error">
            {t('segments.uncovered', { cells: missing.map(([r, f]) => `R${r}F${f}`).join(', ') })}
          </Alert>
        </div>
      )}
      {error && missing.length === 0 && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {preview && (
        <p className="mt-3 text-xs text-ink-muted">
          {t('segments.previewNote', {
            date: preview.asOf,
            none: formatNumber(preview.noPurchases),
          })}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={doPreview} disabled={pending || missing.length > 0}>
          {t('segments.previewButton')}
        </Button>
        <Button onClick={save} disabled={pending || missing.length > 0}>
          {t('segments.save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('customer.cancel')}
        </Button>
      </div>
    </Card>
  );
}
