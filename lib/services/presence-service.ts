import type { Server, Socket } from 'socket.io';

interface PresenceEntry {
  userId: string;
  socketId: string;
  connectedAt: number;
  focused: boolean;
  lastFocusedAt: number | null;
  lastBlurredAt: number | null;
}

export class PresenceService {
  private readonly clients = new Map<string, PresenceEntry>(); // keyed by socketId

  init(io: Server): void {
    io.on('connection', (socket: Socket & { userId?: string }) => {
      const userId = socket.userId;
      if (!userId) return; // guests: socket connects but we don't track them

      this.clients.set(socket.id, {
        userId,
        socketId: socket.id,
        connectedAt: Date.now(),
        focused: false, // updated by client on connect via presence:focus/blur
        lastFocusedAt: null,
        lastBlurredAt: null,
      });

      socket.on('presence:focus', () => {
        const entry = this.clients.get(socket.id);
        if (entry) {
          entry.focused = true;
          entry.lastFocusedAt = Date.now();
        }
      });

      socket.on('presence:blur', () => {
        const entry = this.clients.get(socket.id);
        if (entry) {
          entry.focused = false;
          entry.lastBlurredAt = Date.now();
        }
      });

      socket.on('disconnect', () => {
        this.clients.delete(socket.id);
      });
    });
  }

  getClients(): PresenceEntry[] {
    return Array.from(this.clients.values());
  }
}
