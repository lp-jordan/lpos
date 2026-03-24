import type { Server as SocketIOServer } from 'socket.io';
import type { ServiceRegistry } from './registry';
import { createWorkbookState } from '@/lib/passprep/workbook';
import type { CourseState } from '@/lib/passprep/core';

/**
 * PassPrepService
 *
 * Pass Prep now lives inside LPOS as pure function calls plus
 * a light service registry/socket presence for operator visibility.
 */
export class PassPrepService {
  constructor(
    private io: SocketIOServer,
    private registry: ServiceRegistry,
  ) {}

  async start(): Promise<void> {
    this.registry.register('passprep', 'Pass Prep');

    // No socket namespace needed yet — generation is request/response via API routes.
    // Will add /passprep namespace when streaming generation progress is implemented.

    this.registry.update('passprep', 'running');
    console.log('[passprep] service running');
  }

  async stop(): Promise<void> {
    this.registry.update('passprep', 'stopped');
    console.log('[passprep] service stopped');
  }

  publishWorkbookState(projectId: string, courseState: CourseState): CourseState {
    const nextState = courseState.workbook ? courseState : createWorkbookState(courseState);
    this.io.of('/passprep').emit('workbook:state', { projectId, courseState: nextState });
    return nextState;
  }
}
