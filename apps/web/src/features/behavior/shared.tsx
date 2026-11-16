import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from '../../components/forms';
import { ApiError } from '../../lib/api';

/** Errors and envelope warnings shared by the three panels. */
export function QueryNotices({
  error,
  warnings,
}: {
  error: unknown;
  warnings: { code: string; message: string }[] | undefined;
}) {
  const { t } = useTranslation();
  return (
    <>
      {error ? (
        <div className="mb-3">
          <Alert tone="error">
            {error instanceof ApiError && error.status === 503
              ? t('overview.analyticsDown')
              : error instanceof ApiError && error.status === 409
                ? t('behavior.noSnapshot')
                : t('errors.generic')}
          </Alert>
        </div>
      ) : null}
      {warnings?.map((w) => (
        <div key={w.code} className="mb-3">
          <Alert tone="info">{w.message}</Alert>
        </div>
      ))}
    </>
  );
}

/** Card heading with an explanation and a CSV download. */
export function PanelHeading({
  title,
  explain,
  onDownload,
  children,
}: {
  title: string;
  explain?: ReactNode;
  onDownload?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
      <div className="max-w-3xl">
        <h2 className="text-sm font-semibold">{title}</h2>
        {explain && <p className="mt-1 text-xs text-ink-muted">{explain}</p>}
      </div>
      <div className="flex items-end gap-2">
        {children}
        {onDownload && (
          <Button variant="secondary" className="px-3 py-1.5" onClick={onDownload}>
            {t('behavior.downloadCsv')}
          </Button>
        )}
      </div>
    </div>
  );
}
