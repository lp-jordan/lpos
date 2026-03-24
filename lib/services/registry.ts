import type { Server as SocketIOServer } from 'socket.io';

export type ServiceStatus = 'starting' | 'running' | 'stopped' | 'error';

export interface ServiceEntry {
  id: string;
  name: string;
  status: ServiceStatus;
  startedAt?: string;
  error?: string;
}

export class ServiceRegistry {
  private services = new Map<string, ServiceEntry>();

  constructor(private io: SocketIOServer) {}

  register(id: string, name: string): void {
    this.services.set(id, { id, name, status: 'starting' });
    this.broadcast();
  }

  update(id: string, status: ServiceStatus, error?: string): void {
    const entry = this.services.get(id);
    if (!entry) return;
    this.services.set(id, {
      ...entry,
      status,
      error,
      startedAt: status === 'running' ? new Date().toISOString() : entry.startedAt,
    });
    this.broadcast();
  }

  list(): ServiceEntry[] {
    return Array.from(this.services.values());
  }

  private broadcast(): void {
    this.io.emit('services:status', this.list());
  }
}
