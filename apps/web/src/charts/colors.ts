import { cssToken } from '../components/EChart';

/** Axis, grid and label colours from the theme tokens (light and dark). */
export function chartColors() {
  return {
    axis: cssToken('--color-line', '#e2e5ea'),
    grid: cssToken('--color-surface-muted', '#f0f2f5'),
    text: cssToken('--color-ink-subtle', '#8a92a1'),
  };
}
