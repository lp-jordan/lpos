/** Emoji reactions on message-style entries — people updates and task comments
 *  both use this set. Fixed rather than a free picker: an open picker fragments
 *  the same sentiment across skin tones and near-duplicate glyphs, which makes
 *  the aggregate tallies useless. */
export const REACTION_EMOJIS = ['👍', '🎉', '❤️', '😂', '👀', '🙌', '🔥', '✅'] as const;

export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export const REACTION_VALUES: readonly string[] = REACTION_EMOJIS;

/** One emoji's tally on one entry. `userIds` carries every reactor so the UI
 *  can both highlight the current user's own reaction and name the others in a
 *  tooltip without a second round-trip. */
export interface MessageReaction {
  emoji:   string;
  userIds: string[];
}

/** Groups flat `(entry, user, emoji)` rows into per-entry, per-emoji tallies.
 *  Emoji order follows REACTION_EMOJIS so a given set always renders in the
 *  same order regardless of who reacted first. */
export function groupReactionRows(
  rows: { entry_id: string; user_id: string; emoji: string }[],
): Map<string, MessageReaction[]> {
  const byEntry = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const byEmoji = byEntry.get(row.entry_id) ?? new Map<string, string[]>();
    const users   = byEmoji.get(row.emoji) ?? [];
    users.push(row.user_id);
    byEmoji.set(row.emoji, users);
    byEntry.set(row.entry_id, byEmoji);
  }

  const out = new Map<string, MessageReaction[]>();
  for (const [entryId, byEmoji] of byEntry) {
    const list = Array.from(byEmoji, ([emoji, userIds]) => ({ emoji, userIds }));
    list.sort((a, b) => REACTION_VALUES.indexOf(a.emoji) - REACTION_VALUES.indexOf(b.emoji));
    out.set(entryId, list);
  }
  return out;
}
