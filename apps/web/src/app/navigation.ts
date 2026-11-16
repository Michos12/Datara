export interface NavItem {
  path: string;
  label: string;
  /** Roadmap milestone that delivers the page (docs/06-roadmap.md). */
  milestone: string;
  summary: string;
}

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Insights',
    items: [
      {
        path: '/',
        label: 'Overview',
        milestone: 'M3',
        summary: 'Executive KPIs, revenue and acquisition trends for any period.',
      },
      {
        path: '/segments',
        label: 'Segments',
        milestone: 'M4',
        summary: 'RFM segmentation: Champions, Loyal, At Risk, Hibernating, Lost and more.',
      },
      {
        path: '/analytics',
        label: 'Behavior',
        milestone: 'M5–M6',
        summary: 'Retention, churn, cohorts, purchase frequency, CLV, journey and engagement.',
      },
      {
        path: '/recommendations',
        label: 'Recommendations',
        milestone: 'M7',
        summary: 'Rule-based opportunities with supporting metrics and suggested actions.',
      },
      {
        path: '/reports',
        label: 'Reports',
        milestone: 'M8',
        summary: 'Period comparisons, CSV exports and PDF reports.',
      },
    ],
  },
  {
    title: 'Data',
    items: [
      {
        path: '/customers',
        label: 'Customers',
        milestone: 'M2',
        summary: 'Customer list, profiles, purchase history and interactions.',
      },
      {
        path: '/imports',
        label: 'Imports',
        milestone: 'M2',
        summary: 'Import customers and orders from CSV with validation and error reports.',
      },
    ],
  },
  {
    title: 'Workspace',
    items: [
      {
        path: '/settings',
        label: 'Settings',
        milestone: 'M1',
        summary: 'Organization, time zone, currency, members and analytics thresholds.',
      },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);
