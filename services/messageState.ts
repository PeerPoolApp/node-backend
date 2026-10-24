/** Messaging read/unread RPC boundary. Service-role only; viewer comes from requireAuth. */
import { supabaseAdmin } from './supabase.js'

export type UnreadState = {
  conversation_id: string
  unread_count: number
  last_read_at: string | null
  last_read_message_id: string | null
  include_in_main: boolean
}

/** Exact counts, including conversations outside the current list/search page. */
export async function unreadStates(
  userId: string,
  conversationIds?: string[],
): Promise<UnreadState[]> {
  const { data, error } = await supabaseAdmin.rpc('message_unread_counts', {
    viewer: userId,
    conversation_ids: conversationIds ?? null,
  })
  if (error) throw error
  return (data ?? []).map((row: UnreadState) => ({
    ...row,
    unread_count: Number(row.unread_count),
  }))
}
