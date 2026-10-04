/**
 * Event calendar origin — friends / group / public event layer (MyTime filters).
 * Mirror of vue-frontend/src/lib/eventOrigin.ts.
 */

export type EventOriginKind = 'friends' | 'group' | 'event'

export type EventOriginInput = {
  visibility: string
  organizer: { type: 'user' | 'community' }
}

export function eventOrigin(ev: EventOriginInput): EventOriginKind {
  if (ev.visibility === 'public') return 'event'
  if (ev.organizer.type === 'community') return 'group'
  return 'friends'
}

export function matchesOriginFilter(
  ev: EventOriginInput,
  kind: EventOriginKind | 'all',
): boolean {
  if (kind === 'all') return true
  return eventOrigin(ev) === kind
}
