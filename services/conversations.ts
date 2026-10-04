/**
 * Conversation helpers: find or create direct chats between two users.
 * Uniqueness enforced by direct_conversation_pairs (user_lo, user_hi).
 */

import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from './supabase.js'

const FRIEND_WELCOME = 'Friend Added'

function orderedPair(userA: string, userB: string): { userLo: string; userHi: string } {
  return userA < userB
    ? { userLo: userA, userHi: userB }
    : { userLo: userB, userHi: userA }
}

/**
 * Look up existing direct conversation id for an unordered pair, if any.
 */
async function findDirectPairConversationId(
  userLo: string,
  userHi: string,
): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('direct_conversation_pairs')
    .select('conversation_id')
    .eq('user_lo', userLo)
    .eq('user_hi', userHi)
    .maybeSingle()
  return data?.conversation_id ?? null
}

/**
 * Find existing direct conversation between two users, or create one.
 * Race-safe via unique (user_lo, user_hi) on direct_conversation_pairs.
 */
export async function findOrCreateDirectConversation(
  userA: string,
  userB: string,
): Promise<string> {
  if (userA === userB) throw new Error('Cannot create direct chat with self')

  const { userLo, userHi } = orderedPair(userA, userB)

  const existing = await findDirectPairConversationId(userLo, userHi)
  if (existing) return existing

  const { data: conversation, error: convError } = await supabaseAdmin
    .from('conversations')
    .insert({ type: 'direct' })
    .select('id')
    .single()

  if (convError || !conversation) throw convError ?? new Error('Could not create conversation')

  const { error: memberError } = await supabaseAdmin.from('conversation_members').insert([
    { conversation_id: conversation.id, user_id: userA, role: 'admin' },
    { conversation_id: conversation.id, user_id: userB, role: 'member' },
  ])

  if (memberError) {
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id)
    throw memberError
  }

  const { error: pairError } = await supabaseAdmin.from('direct_conversation_pairs').insert({
    user_lo: userLo,
    user_hi: userHi,
    conversation_id: conversation.id,
  })

  if (pairError) {
    // Unique violation: another request won the race — use theirs and drop orphan.
    await supabaseAdmin.from('conversations').delete().eq('id', conversation.id)
    const raced = await findDirectPairConversationId(userLo, userHi)
    if (raced) return raced
    throw pairError
  }

  return conversation.id
}

/**
 * Creator welcome on new named chats (event / community channel / group).
 */
export async function sendCreatorWelcomeMessage(
  conversationId: string,
  creatorId: string,
  chatName: string,
): Promise<void> {
  const name = chatName.trim() || 'chat'
  const now = new Date().toISOString()
  await supabaseAdmin.from('messages').insert({
    conversation_id: conversationId,
    sender_id: creatorId,
    body: `Welcome to the ${name} chat`,
    client_id: randomUUID(),
    created_at: now,
  })
  await supabaseAdmin
    .from('conversations')
    .update({ updated_at: now })
    .eq('id', conversationId)
}

/**
 * Insert welcome messages from both users after friend accept.
 */
export async function sendFriendWelcomeMessages(
  conversationId: string,
  requesterId: string,
  addresseeId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await supabaseAdmin.from('messages').insert([
    {
      conversation_id: conversationId,
      sender_id: requesterId,
      body: FRIEND_WELCOME,
      client_id: randomUUID(),
      created_at: now,
    },
    {
      conversation_id: conversationId,
      sender_id: addresseeId,
      body: FRIEND_WELCOME,
      client_id: randomUUID(),
      created_at: now,
    },
  ])
  await supabaseAdmin
    .from('conversations')
    .update({ updated_at: now })
    .eq('id', conversationId)
}

export { FRIEND_WELCOME }
