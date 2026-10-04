/**
 * Max lengths for every text field. Keep identical to vue-frontend/src/lib/textLimits.ts.
 * See `.cursor/rules/text-limits.mdc`.
 */

export const TEXT_LIMITS = {
  email: 254,
  password: 128,
  fullName: 80,
  username: 30,
  search: 80,
  eventTitle: 80,
  eventDescription: 2000,
  locationText: 200,
  messageBody: 4000,
  communityName: 80,
  communityIdentifier: 30,
  communityDescription: 2000,
  communityChannelName: 80,
  hashtag: 30,
  reportDetails: 500,
  pardonBody: 500,
} as const

/** True when value is longer than max (null/undefined counts as 0). */
export function exceedsLimit(value: string | null | undefined, max: number): boolean {
  return (value?.length ?? 0) > max
}
