/** Shared constants and types for Amaran fixture grouping — safe to import in client components. */

export type AmaranFixtureGroup = 'bookshelves' | 'void' | 'mobile';

export const AMARAN_GROUPS: AmaranFixtureGroup[] = ['bookshelves', 'void', 'mobile'];

export const GROUP_LABELS: Record<AmaranFixtureGroup, string> = {
  bookshelves: 'Bookshelves',
  void:        'Void',
  mobile:      'Mobile',
};
