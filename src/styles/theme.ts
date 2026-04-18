/**
 * Global theme tokens (Phase 2 — Sprint 1).
 * UI components will consume these in a later sprint.
 */
export const colors = {
  primarySageGreen: '#9CAE96',
  softLavender: '#D1C4E9',
  mutedCoral: '#F0A8A8',
  background: '#FAFAFA',
  textDark: '#2D3748',
  textMuted: '#718096',
  card: '#FFFFFF',
  fertileTint: 'rgba(156, 174, 150, 0.35)',
  chartGrid: 'rgba(45, 55, 72, 0.12)',
} as const;

export type AppThemeColors = typeof colors;
