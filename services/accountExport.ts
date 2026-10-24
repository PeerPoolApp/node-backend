/** Self-service access copy. Explicit ownership scopes, complete paged reads, and no silent omissions. */
import { supabaseAdmin } from './supabase.js'

type Row = Record<string, unknown>
/** Supabase has a server row cap: every category must be read in bounded, stable pages. */
export async function readAllExportRows(
  read: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>,
  size = 500,
): Promise<Row[]> {
  const rows: Row[] = []
  for (let offset = 0; ;) {
    const result = await read(offset, offset + size - 1)
    if (result.error) throw result.error
    const page = (result.data ?? []) as Row[]
    rows.push(...page)
    if (!page.length) return rows
    offset += page.length
  }
}

/** Processing disclosures must be supplied by the actual operator, never invented in code. */
export function processingInformation() {
  return {
    controller: process.env.PRIVACY_CONTROLLER_NAME || 'Not configured by the operator',
    contact: process.env.PRIVACY_CONTACT_EMAIL || 'Not configured by the operator',
    purposes:
      'Account access, social connections, planning events, communities, messaging, safety and notification delivery.',
    categories:
      'Account/profile, interests derived from attended events, friendships, memberships, event activity, messages and own media, notifications, preferences and own moderation submissions.',
    recipients:
      process.env.PRIVACY_RECIPIENTS ||
      'Service providers configured by the operator; other participants receive content according to its visibility. Consult the current privacy notice for provider and transfer details.',
    retention:
      process.env.PRIVACY_RETENTION ||
      'Retained according to the operator privacy policy. Account deletion anonymizes the account and removes personal message content and media; some relationship records remain.',
    sources:
      'Information you provide, your activity, and other members’ invitations and relationship actions. Interest scores are derived from attended events.',
    automatedDecisions:
      'Interest scores personalize interests and recommendations. The service does not use these scores for decisions with legal or similarly significant effects.',
    rights:
      'You can request access, correction, erasure, restriction, objection and applicable portability, and complain to a supervisory authority (in Austria: Datenschutzbehörde, dsb.gv.at).',
    scope:
      'This self-service copy contains the application records listed below, read during export generation. It is not a transactionally consistent database snapshot. Authentication credentials, live push/invite tokens and other people’s messages are excluded. Operational/provider logs and case-specific third-party disclosures require a request to the controller.',
    files:
      'Own media files are embedded in the PDF. JSON contains their storage metadata. Device-local external calendars are not held by PeerPool and are not included.',
    operatorDisclosureComplete: Boolean(
      process.env.PRIVACY_CONTROLLER_NAME &&
      process.env.PRIVACY_CONTACT_EMAIL &&
      process.env.PRIVACY_RECIPIENTS &&
      process.env.PRIVACY_RETENTION,
    ),
  }
}

/** No arbitrary table/filter input is accepted from a client. All queries scope the authenticated subject. */
export async function collectPersonalData(userId: string, email?: string | null) {
  const exportedAt = new Date().toISOString()
  const profile = await supabaseAdmin.from('profiles').select('*').eq('id', userId).single()
  if (profile.error) throw profile.error
  const auth = await supabaseAdmin.auth.admin.getUserById(userId)
  if (auth.error) throw auth.error
  const subject = auth.data.user
  const definitions = [
    ['communitiesCreated', 'communities', '*', 'created_by', 'id'],
    ['tags', 'user_hashtags', '*', 'user_id', 'hashtag_id'],
    ['communities', 'community_members', '*', 'user_id', 'community_id'],
    ['communityRoles', 'community_member_roles', '*', 'user_id', 'community_id,role'],
    ['eventsOrganized', 'events', '*', 'organizer_user_id', 'id'],
    ['eventRsvp', 'event_participants', '*', 'user_id', 'event_id'],
    ['eventRoles', 'event_member_roles', '*', 'user_id', 'event_id,role'],
    ['eventFavourites', 'event_favourites', '*', 'user_id', 'event_id'],
    ['eventVisibility', 'event_visible_friends', '*', 'user_id', 'event_id'],
    ['conversationMemberships', 'conversation_members', '*', 'user_id', 'conversation_id'],
    ['messagesSent', 'messages', '*', 'sender_id', 'id'],
    ['messageReads', 'message_reads', '*', 'user_id', 'message_id'],
    ['notifications', 'user_notifications', '*', 'user_id', 'id'],
    ['pushDevices', 'push_devices', 'id,platform,created_at', 'user_id', 'id'],
    ['hiddenContent', 'content_hides', '*', 'user_id', 'target_kind,target_id'],
    [
      'reportsSubmitted',
      'reports',
      'id,target_kind,target_id,reason,details,status,created_at,resolved_at',
      'reporter_id',
      'id',
    ],
    ['pardonRequests', 'pardon_requests', '*', 'user_id', 'id'],
    [
      'friendInviteLinks',
      'friend_invite_links',
      'id,enabled,created_by,created_at',
      'created_by',
      'id',
    ],
    [
      'communityInviteLinks',
      'community_invite_links',
      'id,community_id,enabled,created_by,created_at',
      'created_by',
      'id',
    ],
    [
      'eventInviteLinks',
      'event_invite_links',
      'id,event_id,enabled,created_by,created_at',
      'created_by',
      'id',
    ],
    ['friendInviteJoins', 'friend_invite_link_joins', '*', 'user_id', 'link_id'],
    ['communityInviteJoins', 'community_invite_link_joins', '*', 'user_id', 'link_id'],
    ['eventInviteJoins', 'event_invite_link_joins', '*', 'user_id', 'link_id'],
  ] as const
  const categories: Record<string, Row[]> = {}
  // Bounded parallelism avoids saturating the database for a large account.
  for (let i = 0; i < definitions.length; i += 4) {
    await Promise.all(
      definitions.slice(i, i + 4).map(async ([key, table, select, owner, ordering]) => {
        categories[key] = await readAllExportRows((from, to) => {
          let query = supabaseAdmin.from(table).select(select).eq(owner, userId)
          for (const column of ordering.split(',')) query = query.order(column)
          return query.range(from, to)
        })
      }),
    )
  }
  categories.friends = await readAllExportRows((from, to) =>
    supabaseAdmin
      .from('friend_requests')
      .select('*')
      .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
      .order('id')
      .range(from, to),
  )
  const attachments = await readAllExportRows((from, to) =>
    supabaseAdmin
      .from('message_attachments')
      .select(
        'id,message_id,storage_path,mime_type,size_bytes,file_name,created_at,messages!inner(sender_id)',
      )
      .eq('messages.sender_id', userId)
      .order('id')
      .range(from, to),
  )
  categories.messageAttachments = attachments.map(({ messages, ...row }) => row)
  return {
    schemaVersion: 2,
    exportedAt,
    email: email ?? subject.email ?? null,
    account: {
      id: subject.id,
      email: subject.email,
      phone: subject.phone,
      createdAt: subject.created_at,
      lastSignInAt: subject.last_sign_in_at,
      emailConfirmedAt: subject.email_confirmed_at,
      providers: subject.identities?.map((i) => i.provider) ?? [],
    },
    profile: profile.data as Row,
    processingInformation: processingInformation(),
    categories,
  }
}
export type PersonalDataExport = Awaited<ReturnType<typeof collectPersonalData>>

/** Only paths obtained from the caller-owned export records may reach storage. */
export async function loadExportMedia(data: PersonalDataExport) {
  const files: Array<{ name: string; data: Buffer }> = []
  const avatar = data.profile.avatar_storage_path
  const references = [
    ...(typeof avatar === 'string' && avatar
      ? [
          {
            bucket: 'profile-avatars',
            path: avatar,
            name: 'profile-picture.webp',
          },
        ]
      : []),
    ...(data.categories.messageAttachments ?? []).map((row, i) => ({
      bucket: 'chat-media',
      path: String(row.storage_path),
      name: `message-${i + 1}-${String(row.file_name).replace(/[^a-zA-Z0-9_.-]/g, '_')}`,
    })),
    ...(data.categories.communitiesCreated ?? [])
      .filter((row) => row.avatar_storage_path)
      .map((row, i) => ({
        bucket: 'community-avatars',
        path: String(row.avatar_storage_path),
        name: `community-${i + 1}-picture.webp`,
      })),
    ...(data.categories.eventsOrganized ?? [])
      .filter((row) => row.cover_storage_path)
      .map((row, i) => ({
        bucket: 'event-covers',
        path: String(row.cover_storage_path),
        name: `event-${i + 1}-cover.webp`,
      })),
  ]
  for (const ref of references) {
    const result = await supabaseAdmin.storage.from(ref.bucket).download(ref.path)
    if (result.error || !result.data) throw result.error ?? new Error('Could not export media')
    files.push({
      name: ref.name,
      data: Buffer.from(await result.data.arrayBuffer()),
    })
  }
  return files
}
