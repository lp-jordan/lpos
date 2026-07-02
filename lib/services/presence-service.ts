import type { Server, Socket } from 'socket.io';

interface PresenceEntry {
  userId: string;
  socketId: string;
  connectedAt: number;
  focused: boolean;
  lastSeenAt: number;
  lastFocusedAt: number | null;
  lastBlurredAt: number | null;
}

/** One row per user, collapsing every tab/socket that user has open. */
export interface PresenceUser {
  userId: string;
  /** True if ANY of the user's tabs is currently the foreground (visible) tab. */
  focused: boolean;
  /** Number of live LPOS tabs this user has open. */
  tabCount: number;
  /** Earliest connection across the user's tabs. */
  connectedAt: number;
  /** Most recent moment any of the user's tabs was in focus. */
  lastFocusedAt: number | null;
  /** Most recent presence signal across the user's tabs. */
  lastSeenAt: number;
}

// A tab is dropped if we haven't heard a presence signal within this window.
// PresenceReporter heartbeats well inside it (every ~20s), so a live tab always
// stays; a frozen/slept/network-dead tab falls off promptly without waiting for
// socket.io's own ping timeout.
const STALE_MS = 60_000;

export class PresenceService {
  private readonly clients = new Map<string, PresenceEntry>(); // keyed by socketId

  init(io: Server): void {
    io.on('connection', (socket: Socket & { userId?: string }) => {
      const userId = socket.userId;
      if (!userId) return; // guests: socket connects but we don't track them

      // Lazily register: a socket only becomes a presence entry once it sends a
      // real presence signal. The app opens many root-namespace sockets per tab
      // (projects list, activity strip, lighting, slate, restart banner …); only
      // PresenceReporter emits presence:* events, so those feature sockets are
      // never tracked and don't pollute the list with phantom "Backgrounded" rows.
      const touch = (mutate: (entry: PresenceEntry) => void): void => {
        const now = Date.now();
        const entry: PresenceEntry = this.clients.get(socket.id) ?? {
          userId,
          socketId: socket.id,
          connectedAt: now,
          focused: false,
          lastSeenAt: now,
          lastFocusedAt: null,
          lastBlurredAt: null,
        };
        entry.lastSeenAt = now;
        mutate(entry);
        this.clients.set(socket.id, entry);
      };

      socket.on('presence:focus', () => touch((entry) => {
        entry.focused = true;
        entry.lastFocusedAt = Date.now();
      }));

      socket.on('presence:blur', () => touch((entry) => {
        entry.focused = false;
        entry.lastBlurredAt = Date.now();
      }));

      // Heartbeat — keeps a live tab from being pruned without changing focus state.
      socket.on('presence:ping', () => touch(() => { /* lastSeenAt bump only */ }));

      socket.on('disconnect', () => {
        this.clients.delete(socket.id);
      });
    });
  }

  /** Live per-socket entries, with stale ones pruned as a side effect. */
  private liveEntries(): PresenceEntry[] {
    const cutoff = Date.now() - STALE_MS;
    const live: PresenceEntry[] = [];
    for (const [socketId, entry] of this.clients) {
      if (entry.lastSeenAt < cutoff) {
        this.clients.delete(socketId);
        continue;
      }
      live.push(entry);
    }
    return live;
  }

  getClients(): PresenceEntry[] {
    return this.liveEntries();
  }

  /** One entry per user, collapsing all of that user's tabs. */
  getUsers(): PresenceUser[] {
    const byUser = new Map<string, PresenceUser>();
    for (const entry of this.liveEntries()) {
      const existing = byUser.get(entry.userId);
      if (!existing) {
        byUser.set(entry.userId, {
          userId: entry.userId,
          focused: entry.focused,
          tabCount: 1,
          connectedAt: entry.connectedAt,
          lastFocusedAt: entry.lastFocusedAt,
          lastSeenAt: entry.lastSeenAt,
        });
        continue;
      }
      existing.tabCount += 1;
      existing.focused = existing.focused || entry.focused;
      existing.connectedAt = Math.min(existing.connectedAt, entry.connectedAt);
      existing.lastSeenAt = Math.max(existing.lastSeenAt, entry.lastSeenAt);
      const latestFocus = Math.max(existing.lastFocusedAt ?? 0, entry.lastFocusedAt ?? 0);
      existing.lastFocusedAt = latestFocus > 0 ? latestFocus : null;
    }
    return Array.from(byUser.values());
  }
}
