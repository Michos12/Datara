import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button } from '../../components/forms';
import { ApiError, apiGet, apiRequest } from '../../lib/api';
import { customerKeys } from './queries';

interface JobStatus {
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  error: string | null;
}

/** Owner-only: fills an empty organization with synthetic data, then refreshes the lists. */
export function DemoDataButton() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    const timer = setInterval(async () => {
      try {
        const job = await apiGet<JobStatus>(`/jobs/${jobId}`);
        if (job.status === 'succeeded') {
          setJobId(null);
          await queryClient.invalidateQueries({ queryKey: customerKeys.all });
        } else if (job.status === 'failed') {
          setJobId(null);
          setError(t('demo.failed', { reason: job.error ?? '' }));
        }
      } catch {
        // transient: keep polling
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [jobId, queryClient, t]);

  async function start() {
    setError(null);
    try {
      const res = await apiRequest<{ jobId: string }>('POST', '/organization/demo-data', {
        body: { size: 'medium' },
      });
      setJobId(res.jobId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.network'));
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="secondary" onClick={start} disabled={jobId !== null}>
        {jobId ? t('demo.loading') : t('demo.cta')}
      </Button>
      <p className="text-xs text-ink-subtle">{t('demo.hint')}</p>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
