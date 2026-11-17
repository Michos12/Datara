export interface NavItem {
  path: string;
  /** i18n key under `nav.` */
  key:
    | 'overview'
    | 'segments'
    | 'analytics'
    | 'value'
    | 'recommendations'
    | 'reports'
    | 'customers'
    | 'imports'
    | 'settings'
    | 'methodology';
  /** Roadmap milestone that delivers the page (docs/06-roadmap.md). */
  milestone: string;
  summary: string;
}

export const NAV_SECTIONS: { key: 'insights' | 'data' | 'workspace'; items: NavItem[] }[] = [
  {
    key: 'insights',
    items: [
      {
        path: '/',
        key: 'overview',
        milestone: 'M3',
        summary: 'Executive KPIs, revenue and acquisition trends for any period.',
      },
      {
        path: '/segments',
        key: 'segments',
        milestone: 'M4',
        summary: 'RFM segmentation: Champions, Loyal, At Risk, Hibernating, Lost and more.',
      },
      {
        path: '/analytics',
        key: 'analytics',
        milestone: 'M5',
        summary: 'Retention, churn and acquisition cohorts.',
      },
      {
        path: '/value',
        key: 'value',
        milestone: 'M6',
        summary: 'Purchase frequency, lifetime value, customer journey and engagement.',
      },
      {
        path: '/recommendations',
        key: 'recommendations',
        milestone: 'M7',
        summary: 'Rule-based opportunities with supporting metrics and suggested actions.',
      },
      {
        path: '/reports',
        key: 'reports',
        milestone: 'M8',
        summary: 'Period comparisons, CSV exports and PDF reports.',
      },
    ],
  },
  {
    key: 'data',
    items: [
      {
        path: '/customers',
        key: 'customers',
        milestone: 'M2',
        summary: 'Customer list, profiles, purchase history and interactions.',
      },
      {
        path: '/imports',
        key: 'imports',
        milestone: 'M2',
        summary: 'Import customers and orders from CSV with validation and error reports.',
      },
    ],
  },
  {
    key: 'workspace',
    items: [
      {
        path: '/settings',
        key: 'settings',
        milestone: 'M1',
        summary: 'Organization, time zone, currency and analytics thresholds.',
      },
      {
        path: '/methodology',
        key: 'methodology',
        milestone: 'M3',
        summary: 'How every metric is defined and calculated.',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);
