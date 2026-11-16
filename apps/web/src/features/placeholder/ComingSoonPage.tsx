import { useTranslation } from 'react-i18next';
import type { NavItem } from '../../app/navigation';
import { Card, PageHeader } from '../../components/PageHeader';

/** Placeholder for modules delivered in later milestones. */
export function ComingSoonPage({ item }: { item: NavItem }) {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t(`nav.${item.key}`)} description={item.summary} />
      <Card className="flex flex-col items-start gap-2">
        <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
          Planned for {item.milestone}
        </span>
        <p className="text-sm text-ink-muted">
          This module is not built yet. See the roadmap in <code>docs/06-roadmap.md</code> for its
          scope and acceptance criteria.
        </p>
      </Card>
    </>
  );
}
