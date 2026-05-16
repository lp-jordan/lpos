/**
 * Fuzzy-match helpers for "did you mean…?" prompts.
 *
 * Used by the Projects → People wiring to warn when a user types a new client
 * name that's similar (but not identical) to an existing People entry. The
 * matching is BILATERAL — we check both directions so "Acme" matches "Acme Corp"
 * AND "Acme Corp" matches "Acme".
 *
 * The three signals (lowercase+trim equality, substring containment, and a
 * Levenshtein distance of ≤3) cover the common typos we've seen in the wild
 * without triggering on genuinely different names. Keep the thresholds tuned
 * to the dataset — the People CRM only has a handful of entries so we can
 * afford a slightly looser match.
 */

/** Normalize for comparison: lowercased + collapsed whitespace + trimmed. */
export function normalizeName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Levenshtein edit distance. O(m*n) — fine for our short company-name strings;
 * this is not called inside a tight loop over thousands of entries.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Two-row rolling buffer to keep memory O(min(a, b)).
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,          // insertion
        prev[j] + 1,              // deletion
        prev[j - 1] + cost,       // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

export type FuzzyMatchReason = 'exact' | 'substring' | 'levenshtein';

export interface FuzzyMatch {
  /** The candidate string that matched (as originally cased). */
  candidate: string;
  /** Why we think it matches — lets the UI explain the suggestion. */
  reason: FuzzyMatchReason;
  /** Edit distance if reason === 'levenshtein'; null otherwise. */
  distance: number | null;
}

const LEVENSHTEIN_THRESHOLD = 3;

/**
 * Test whether two names are similar enough to warrant a "did you mean?" prompt.
 *
 * Checks in order (cheapest first):
 *   1. Normalized equality
 *   2. Either name is a substring of the other (case-insensitive)
 *   3. Levenshtein distance on normalized forms ≤ threshold
 *
 * Returns the match reason on hit, null on miss. The bilateral substring check
 * means "Acme" matches "Acme Corp" AND vice versa.
 */
export function findSimilarity(a: string, b: string): { reason: FuzzyMatchReason; distance: number | null } | null {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return null;
  if (na === nb) return { reason: 'exact', distance: 0 };
  if (na.includes(nb) || nb.includes(na)) return { reason: 'substring', distance: null };
  const d = levenshtein(na, nb);
  if (d <= LEVENSHTEIN_THRESHOLD) return { reason: 'levenshtein', distance: d };
  return null;
}

/** Find every candidate similar to `query`, sorted by closeness (best first). */
export function findSimilarMatches(query: string, candidates: string[]): FuzzyMatch[] {
  const matches: FuzzyMatch[] = [];
  for (const c of candidates) {
    const sim = findSimilarity(query, c);
    if (sim) matches.push({ candidate: c, reason: sim.reason, distance: sim.distance });
  }
  // Sort: exact > substring > levenshtein (by distance ascending).
  const rank = (m: FuzzyMatch): number => {
    if (m.reason === 'exact') return -2;
    if (m.reason === 'substring') return -1;
    return m.distance ?? 99;
  };
  matches.sort((x, y) => rank(x) - rank(y));
  return matches;
}
