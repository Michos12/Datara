import axe from 'axe-core';

/**
 * Runs axe-core (WCAG 2.1 A and AA rules) on the rendered document and returns readable
 * violations. Colour contrast cannot be computed in jsdom (no layout); it is checked on the
 * design tokens instead (docs/09-accessibility.md).
 */
export async function axeViolations(root: Element = document.body): Promise<string[]> {
  const result = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map(
    (v) =>
      `${v.id}: ${v.help} (${v.nodes
        .map((n) => n.target.join(' '))
        .slice(0, 3)
        .join(' | ')})`,
  );
}
