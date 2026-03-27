import type { NextRequest } from 'next/server';
import type { ActivityActor, ActivityActorType } from '@/lib/models/activity';

export function resolveRequestActor(req: NextRequest): ActivityActor {
  const actorId = req.headers.get('x-lpos-actor-id')?.trim() || null;
  const actorDisplay = req.headers.get('x-lpos-actor-display')?.trim() || null;
  const rawType = req.headers.get('x-lpos-actor-type')?.trim() || null;
  const actorType = normalizeActorType(rawType, actorId, actorDisplay);

  return {
    actor_type: actorType,
    actor_id: actorId,
    actor_display: actorDisplay,
  };
}

function normalizeActorType(
  value: string | null,
  actorId: string | null,
  actorDisplay: string | null,
): ActivityActorType {
  const allowed = new Set<ActivityActorType>([
    'user',
    'system',
    'service',
    'external_user',
    'external_system',
    'agent',
  ]);

  if (value && allowed.has(value as ActivityActorType)) return value as ActivityActorType;
  if (actorId || actorDisplay) return 'user';
  return 'system';
}
