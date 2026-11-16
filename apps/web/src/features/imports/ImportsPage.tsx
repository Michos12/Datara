import {
  DATE_FORMATS,
  IMPORT_ENTITIES,
  IMPORT_FIELDS,
  importSchema,
  importUploadResponseSchema,
  type Import,
  type ImportEntity,
  type ImportOptions,
} from '@ci/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';
import { Alert, Button, SelectField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { ApiError, apiDownload, apiGet, apiRequest, apiUpload } from '../../lib/api';
import { formatDateTime, formatNumber } from '../../lib/format';
import { useSession } from '../auth/AuthProvider';
import { customerKeys } from '../customers/queries';

const TRANSIENT = new Set(['validating', 'importing']);

interface Draft {
  importId: string;
  columns: string[];
  sample: Record<string, string>[];
  mapping: Record<string, string | null>;
  options: ImportOptions;
}

export function ImportsPage() {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const [entity, setEntity] = useState<ImportEntity>('customers');
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingMapping, setEditingMapping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const current = useQuery({
    queryKey: ['imports', draft?.importId],
    enabled: Boolean(draft),
    queryFn: ({ signal }) =>
      apiGet(`/imports/${draft!.importId}`, { schema: importSchema, signal }),
    refetchInterval: (query) =>
      query.state.data && TRANSIENT.has(query.state.data.status) ? 1000 : false,
  });
  const history = useQuery({
    queryKey: ['imports', 'history'],
    queryFn: ({ signal }) =>
      apiGet('/imports', { schema: z.object({ data: z.array(importSchema) }), signal }),
    refetchInterval: current.data && TRANSIENT.has(current.data.status) ? 2000 : false,
  });

  const imp = current.data;
  // Once an import completes, customer lists and stats elsewhere are stale.
  const completedId = imp?.status === 'completed' ? imp.id : null;
  useEffect(() => {
    if (completedId) void queryClient.invalidateQueries({ queryKey: customerKeys.all });
  }, [completedId, queryClient]);

  if (session.role !== 'OWNER' && session.role !== 'ADMIN') {
    return (
      <>
        <PageHeader title={t('imports.title')} />
        <Alert tone="info">{t('settings.readOnly')}</Alert>
      </>
    );
  }

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    setPending(true);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
      return undefined;
    } finally {
      setPending(false);
    }
  }

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    const res = await run(() =>
      apiUpload(
        `/imports?entity=${entity}&filename=${encodeURIComponent(file.name)}`,
        file,
        'text/csv',
        importUploadResponseSchema,
      ),
    );
    if (!res) return;
    setDraft({
      importId: res.import.id,
      columns: res.import.columns,
      sample: res.sampleRows,
      mapping: res.suggestedMapping,
      options: { dateFormat: 'auto', decimalSeparator: '.', amountsInMinorUnits: false },
    });
    setEditingMapping(true);
    queryClient.setQueryData(['imports', res.import.id], res.import);
  }

  async function validate() {
    if (!draft) return;
    const updated = await run(() =>
      apiRequest('PUT', `/imports/${draft.importId}/mapping`, {
        body: { mapping: draft.mapping, options: draft.options },
        schema: importSchema,
      }),
    );
    if (updated) {
      queryClient.setQueryData(['imports', draft.importId], updated);
      setEditingMapping(false);
    }
  }

  async function commit() {
    if (!draft) return;
    const updated = await run(() =>
      apiRequest('POST', `/imports/${draft.importId}/commit`, { schema: importSchema }),
    );
    if (updated) queryClient.setQueryData(['imports', draft.importId], updated);
  }

  function reset() {
    setDraft(null);
    setFile(null);
    setEditingMapping(false);
    setError(null);
  }

  const fields = IMPORT_FIELDS[(imp?.entity ?? entity) as ImportEntity];

  return (
    <>
      <PageHeader title={t('imports.title')} description={t('imports.description')} />
      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {!draft && (
        <Card>
          <form onSubmit={upload} className="flex flex-col gap-4">
            <SelectField
              label={t('imports.entity')}
              value={entity}
              onChange={(e) => setEntity(e.target.value as ImportEntity)}
              options={IMPORT_ENTITIES.map((value) => ({
                value,
                label: t(`imports.entities.${value}`),
              }))}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="import-file" className="text-sm font-medium">
                {t('imports.file')}
              </label>
              <input
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-3 file:rounded-lg file:border file:border-line file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm"
              />
              <p className="text-xs text-ink-subtle">{t('imports.fileHint')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={!file || pending}>
                {pending ? t('imports.uploading') : t('imports.upload')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  apiDownload(`/imports/templates/${entity}.csv`, `${entity}-template.csv`)
                }
              >
                {t('imports.template')}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {draft && editingMapping && (
        <Card>
          <h2 className="text-sm font-semibold">{t('imports.stepMap')}</h2>
          <p className="mt-1 text-xs text-ink-muted">{t('imports.stepMapHint')}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {fields.map((field) => (
              <SelectField
                key={field.key}
                label={`${field.label}${field.required ? ` · ${t('imports.required')}` : ''}`}
                hint={field.description || undefined}
                value={draft.mapping[field.key] ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    mapping: { ...draft.mapping, [field.key]: e.target.value || null },
                  })
                }
                options={[
                  { value: '', label: `— ${t('imports.notImported')} —` },
                  ...draft.columns.map((c) => ({ value: c, label: c })),
                ]}
              />
            ))}
          </div>

          <h3 className="mt-6 text-sm font-semibold">{t('imports.options')}</h3>
          <div className="mt-2 grid gap-3 md:grid-cols-3">
            <SelectField
              label={t('imports.dateFormat')}
              value={draft.options.dateFormat}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  options: {
                    ...draft.options,
                    dateFormat: e.target.value as ImportOptions['dateFormat'],
                  },
                })
              }
              options={DATE_FORMATS.map((f) => ({
                value: f,
                label: t(`imports.dateFormats.${f}`),
              }))}
            />
            <SelectField
              label={t('imports.decimalSeparator')}
              value={draft.options.decimalSeparator}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  options: { ...draft.options, decimalSeparator: e.target.value as '.' | ',' },
                })
              }
              options={[
                { value: '.', label: t('imports.decimalDot') },
                { value: ',', label: t('imports.decimalComma') },
              ]}
            />
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <input
                type="checkbox"
                checked={draft.options.amountsInMinorUnits}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    options: { ...draft.options, amountsInMinorUnits: e.target.checked },
                  })
                }
              />
              {t('imports.minorUnits')}
            </label>
          </div>

          <h3 className="mt-6 text-sm font-semibold">{t('imports.preview')}</h3>
          <div className="mt-2 overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-muted">
                <tr>
                  {draft.columns.map((c) => (
                    <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {draft.sample.map((row, i) => (
                  <tr key={i}>
                    {draft.columns.map((c) => (
                      <td key={c} className="whitespace-nowrap px-3 py-1.5 text-ink-muted">
                        {row[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 flex gap-2">
            <Button onClick={validate} disabled={pending}>
              {t('imports.validate')}
            </Button>
            <Button variant="ghost" onClick={reset}>
              {t('customer.cancel')}
            </Button>
          </div>
        </Card>
      )}

      {draft && !editingMapping && imp && (
        <ImportProgress
          imp={imp}
          pending={pending}
          onCommit={commit}
          onRemap={() => setEditingMapping(true)}
          onReset={reset}
        />
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold">{t('imports.history')}</h2>
      <ImportHistory imports={history.data?.data ?? []} />
    </>
  );
}

function ImportProgress({
  imp,
  pending,
  onCommit,
  onRemap,
  onReset,
}: {
  imp: Import;
  pending: boolean;
  onCommit: () => void;
  onRemap: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <h2 className="text-sm font-semibold">{t('imports.stepReview')}</h2>
      {imp.status === 'validating' && (
        <p className="mt-3 text-sm text-ink-muted" role="status">
          {t('imports.validating')}
        </p>
      )}
      {imp.status === 'importing' && (
        <p className="mt-3 text-sm text-ink-muted" role="status">
          {t('imports.importing')}
        </p>
      )}
      {imp.status === 'failed' && (
        <div className="mt-3">
          <Alert tone="error">{t('imports.failed', { reason: imp.failureReason ?? '' })}</Alert>
        </div>
      )}

      {imp.status === 'validated' && (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm">
            {t('imports.summary', {
              valid: formatNumber(imp.rowsValid),
              total: formatNumber(imp.rowsTotal),
            })}
          </p>
          {imp.rowsFailed > 0 && (
            <>
              <Alert tone="info">{t('imports.failedRows', { count: imp.rowsFailed })}</Alert>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="bg-surface-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t('imports.line')}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t('imports.field')}
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t('imports.problem')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {imp.errorSample.slice(0, 20).map((e, i) => (
                      <tr key={i}>
                        <td className="px-3 py-1.5 tabular-nums">{e.line}</td>
                        <td className="px-3 py-1.5">{e.field ?? '—'}</td>
                        <td className="px-3 py-1.5 text-ink-muted">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <Button
                  variant="ghost"
                  onClick={() => apiDownload(`/imports/${imp.id}/errors.csv`, 'import-errors.csv')}
                >
                  {t('imports.downloadErrors')}
                </Button>
              </div>
            </>
          )}
          <div className="flex gap-2">
            <Button onClick={onCommit} disabled={pending || imp.rowsValid === 0}>
              {t('imports.commit', { count: imp.rowsValid })}
            </Button>
            <Button variant="secondary" onClick={onRemap}>
              {t('imports.remap')}
            </Button>
          </div>
        </div>
      )}

      {imp.status === 'completed' && (
        <div className="mt-3 flex flex-col items-start gap-3">
          <Alert tone="success">
            {t('imports.done', {
              inserted: imp.rowsInserted,
              updated: imp.rowsUpdated,
              skipped: imp.rowsFailed,
            })}
          </Alert>
          <div className="flex gap-2">
            <Link
              to="/customers"
              className="inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              {t('customers.title')}
            </Link>
            <Button variant="secondary" onClick={onReset}>
              {t('imports.startOver')}
            </Button>
          </div>
        </div>
      )}
      {imp.status === 'failed' && (
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={onRemap}>
            {t('imports.remap')}
          </Button>
          <Button variant="ghost" onClick={onReset}>
            {t('imports.startOver')}
          </Button>
        </div>
      )}
    </Card>
  );
}

function ImportHistory({ imports }: { imports: Import[] }) {
  const { t } = useTranslation();
  if (imports.length === 0)
    return <p className="text-sm text-ink-muted">{t('imports.noHistory')}</p>;
  return (
    <Card className="overflow-hidden p-0">
      <table className="w-full text-left text-sm">
        <tbody className="divide-y divide-line">
          {imports.map((i) => (
            <tr key={i.id}>
              <td className="px-4 py-2">
                <div className="font-medium">{i.originalName}</div>
                <div className="text-xs text-ink-subtle">{formatDateTime(i.createdAt)}</div>
              </td>
              <td className="px-4 py-2 text-ink-muted">{t(`imports.entities.${i.entity}`)}</td>
              <td className="px-4 py-2">{t(`imports.status.${i.status}`)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                {i.status === 'completed'
                  ? `+${formatNumber(i.rowsInserted)} / ↻${formatNumber(i.rowsUpdated)}`
                  : i.rowsTotal > 0
                    ? `${formatNumber(i.rowsValid)}/${formatNumber(i.rowsTotal)}`
                    : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
