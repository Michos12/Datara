import { BEHAVIOR_GRAINS, type BehaviorGrain } from '@ci/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { SelectField } from '../../components/forms';
import { Card, PageHeader } from '../../components/PageHeader';
import { useSession } from '../auth/AuthProvider';
import { monthStart, todayIn, type Range } from '../overview/periods';
import { useSegmentConfig } from '../segments/queries';
import { ChurnPanel } from './ChurnPanel';
import { CohortsPanel } from './CohortsPanel';
import { RetentionPanel } from './RetentionPanel';

const TABS = ['retention', 'churn', 'cohorts'] as const;
type Tab = (typeof TABS)[number];

const RANGES = { last_6_months: 6, last_12_months: 12, last_24_months: 24 } as const;
type RangeKey = keyof typeof RANGES;

/** The last `months` complete calendar months in the organization's time zone. */
export function lastMonths(months: number, today: string): Range {
  return { start: monthStart(today, -months), end: monthStart(today) };
}

export function BehaviorPage() {
  const { t } = useTranslation();
  const session = useSession();
  const [search, setSearch] = useSearchParams();
  const tab: Tab = TABS.find((x) => x === search.get('tab')) ?? 'retention';
  const [rangeKey, setRangeKey] = useState<RangeKey>('last_12_months');
  const [grain, setGrain] = useState<BehaviorGrain | ''>('');
  const [segment, setSegment] = useState('');
  const segmentConfig = useSegmentConfig();
  const range = lastMonths(RANGES[rangeKey], todayIn(session.organization.timezone));
  const filters = { range, grain, segment };

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
      <PageHeader title={t('behavior.title')} description={t('behavior.description')} />

      <div role="tablist" aria-label={t('behavior.tabsLabel')} className="mb-4 flex gap-1">
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
            {t(`behavior.tabs.${key}`)}
          </button>
        ))}
      </div>

      <Card className="mb-4 p-4">
        <div className="grid gap-3 md:grid-cols-3">
          <SelectField
            label={t('behavior.range')}
            value={rangeKey}
            onChange={(e) => setRangeKey(e.target.value as RangeKey)}
            options={Object.keys(RANGES).map((key) => ({
              value: key,
              label: t(`behavior.ranges.${key}`),
            }))}
          />
          {tab !== 'cohorts' && (
            <SelectField
              label={t('behavior.grain')}
              value={grain}
              onChange={(e) => setGrain(e.target.value as BehaviorGrain | '')}
              options={[
                { value: '', label: t('behavior.grains.auto') },
                ...BEHAVIOR_GRAINS.map((g) => ({ value: g, label: t(`behavior.grains.${g}`) })),
              ]}
            />
          )}
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
        {tab === 'retention' && <RetentionPanel filters={filters} />}
        {tab === 'churn' && (
          <ChurnPanel filters={filters} canSeeCustomers={session.role !== 'VIEWER'} />
        )}
        {tab === 'cohorts' && <CohortsPanel range={range} segment={segment} />}
      </div>
    </>
  );
}
