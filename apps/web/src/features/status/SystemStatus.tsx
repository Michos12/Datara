import { useReadiness } from './useReadiness';

type Tone = 'ok' | 'warn' | 'down' | 'pending';

const TONE_CLASSES: Record<Tone, string> = {
  ok: 'bg-positive',
  warn: 'bg-warning',
  down: 'bg-negative',
  pending: 'bg-ink-subtle',
};

/** Compact system status indicator for the header. */
export function SystemStatus() {
  const { data, isPending, isError } = useReadiness();

  let tone: Tone = 'pending';
  let label = 'Checking services…';
  if (isError) {
    tone = 'down';
    label = 'API unreachable';
  } else if (data) {
    if (data.status !== 'ready') {
      tone = 'down';
      label = 'API not ready';
    } else if (data.checks.analytics === 'down') {
      tone = 'warn';
      label = 'Analytics unavailable';
    } else {
      tone = 'ok';
      label = 'All systems operational';
    }
  }

  return (
    <div
      className="flex items-center gap-2 text-xs text-ink-muted"
      role="status"
      aria-live="polite"
      title={
        data
          ? `Database ${data.checks.database} · Migrations ${data.checks.migrations} · Analytics ${data.checks.analytics}`
          : undefined
      }
    >
      <span
        aria-hidden="true"
        className={`inline-block size-2 rounded-full ${TONE_CLASSES[tone]} ${isPending ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </div>
  );
}
