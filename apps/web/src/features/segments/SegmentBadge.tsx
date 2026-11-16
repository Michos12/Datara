import { useTranslation } from 'react-i18next';
import { segmentLookup, useSegmentConfig } from './queries';

/** Coloured segment label. `segmentKey` null means not scored (no purchases yet). */
export function SegmentBadge({ segmentKey }: { segmentKey: string | null }) {
  const { t } = useTranslation();
  const config = useSegmentConfig();
  const info = segmentKey ? segmentLookup(config.data).get(segmentKey) : null;
  const name = segmentKey ? (info?.name ?? segmentKey) : t('segments.noPurchases');
  const color = info?.color ?? '#8a92a1';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-surface-muted px-2 py-0.5 text-xs">
      <span aria-hidden="true" className="size-2 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
