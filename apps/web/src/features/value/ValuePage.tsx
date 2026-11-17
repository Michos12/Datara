import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { SelectField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { useSession } from '../auth/AuthProvider';
import { lastMonths } from '../behavior/BehaviorPage';
import { todayIn } from '../overview/periods';
import { useSegmentConfig } from '../segments/queries';
import { ClvPanel } from './ClvPanel';
import { EngagementPanel } from './EngagementPanel';
import { FrequencyPanel } from './FrequencyPanel';
import { JourneyPanel } from './JourneyPanel';

const TABS = ['frequency', 'clv', 'journey', 'engagement'] as const;
type Tab = (typeof TABS)[number];

const RANGES = { last_6_months: 6, last_12_months: 12, last_24_months: 24 } as const;
type RangeKey = keyof typeof RANGES;

/** Purchase frequency, lifetime value, journey and engagement (ANA-04 … 07). */
export function ValuePage() {
  const { t } = useTranslation();
  const session = useSession();
  const [search, setSearch] = useSearchParams();
  const tab: Tab = TABS.find((x) => x === search.get('tab')) ?? 'frequency';
  const [rangeKey, setRangeKey] = useState<RangeKey>('last_12_months');
  const [segment, setSegment] = useState('');
  const segmentConfig = useSegmentConfig();
  const range = lastMonths(RANGES[rangeKey], todayIn(session.organization.timezone));
  const filters = { range, segment };

  function selectTab(next: Tab) {
    setSearch(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set('tab', next);
        return params;
      },
      { replace: true },
    );
  }

  return (
    <>
      <PageHeader title={t('value.title')} description={t('value.description')} />

      <div role="tablist" aria-label={t('value.tabsLabel')} className="mb-4 flex flex-wrap gap-1">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`tab-${key}`}
            aria-selected={tab === key}
            aria-controls={`panel-${key}`}
            onClick={() => selectTab(key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              tab === key ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface-muted'
            }`}
          >
            {t(`value.tabs.${key}`)}
          </button>
        ))}
      </div>

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <SelectField
            label={tab === 'engagement' ? t('value.engagementRange') : t('value.range')}
            hint={tab === 'engagement' ? undefined : t('value.rangeHint')}
            value={rangeKey}
            onChange={(e) => setRangeKey(e.target.value as RangeKey)}
            options={Object.keys(RANGES).map((key) => ({
              value: key,
              label: t(`behavior.ranges.${key}`),
            }))}
          />
          <SelectField
            label={t('overview.segment')}
            value={segment}
            onChange={(e) => setSegment(e.target.value)}
            options={[
              { value: '', label: t('overview.allCustomers') },
              ...(segmentConfig.data?.config.rules ?? []).map((r) => ({
                value: r.key,
                label: r.name,
              })),
            ]}
          />
        </div>
      </Card>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'frequency' && <FrequencyPanel filters={filters} />}
        {tab === 'clv' && <ClvPanel filters={filters} />}
        {tab === 'journey' && <JourneyPanel filters={filters} />}
        {tab === 'engagement' && <EngagementPanel filters={filters} />}
      </div>
    </>
  );
}

/** A headline number with a short explanation. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-subtle">{hint}</p>}
    </div>
  );
}
