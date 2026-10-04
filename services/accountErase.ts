/**
 * In-place account erase (GDPR). Keep UUID so messages/FKs stay; anonymize PII.
 * Do not call auth.admin.deleteUser — profiles/messages cascade would wipe chats.
 */

import { randomBytes } from 'node:crypto'
import { supabaseAdmin } from './supabase.js'
import { PROFILE_AVATARS_BUCKET, avatarStoragePath } from './avatars.js'
import { CHAT_MEDIA_BUCKET } from './messaging.js'

const DELETED_NAME = 'Deleted User'

function deletedUsername(): string {
  return `deleted_user_${randomBytes(4).toString('hex')}`
}

/**
 * Erase the caller's account in place. 409 if they still admin a community.
 */
export async function eraseAccount(userId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { data: adminRows, error: adminErr } = await supabaseAdmin
    .from('community_member_roles')
    .select('community_id')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .limit(1)
  if (adminErr) throw adminErr
  if (adminRows?.length) {
    return {
      ok: false,
      status: 409,
      error: 'Transfer community admin before deleting your account',
    }
  }

  const { data: messages } = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('sender_id', userId)
  const messageIds = (messages ?? []).map((m) => m.id as string)
  if (messageIds.length) {
    const { data: atts } = await supabaseAdmin
      .from('message_attachments')
      .select('storage_path')
      .in('message_id', messageIds)
    const paths = [...new Set((atts ?? []).map((a) => a.storage_path as string).filter(Boolean))]
    if (paths.length) {
      await supabaseAdmin.storage.from(CHAT_MEDIA_BUCKET).remove(paths)
    }
    await supabaseAdmin.from('message_attachments').delete().in('message_id', messageIds)
    await supabaseAdmin.from('messages').update({ body: null }).eq('sender_id', userId)
  }

  await supabaseAdmin.from('user_hashtags').delete().eq('user_id', userId)
  await supabaseAdmin.from('push_devices').delete().eq('user_id', userId)
  await supabaseAdmin
    .from('friend_requests')
    .delete()
    .eq('status', 'pending')
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
  await supabaseAdmin.from('friend_invite_links').delete().eq('created_by', userId)

  const avatarPath = avatarStoragePath(userId)
  await supabaseAdmin.storage.from(PROFILE_AVATARS_BUCKET).remove([avatarPath])

  let username = deletedUsername()
  for (let i = 0; i < 8; i++) {
    const { error } = await supabaseAdmin
      .from('profiles')
      .update({
        full_name: DELETED_NAME,
        username,
        birthday: null,
        deleted_at: new Date().toISOString(),
        avatar_storage_path: null,
        avatar_updated_at: null,
        banned_at: null,
        ban_reason: null,
        ban_details: null,
        app_role: 'user',
      })
      .eq('id', userId)
    if (!error) break
    if (error.code === '23505') {
      username = deletedUsername()
      continue
    }
    throw error
  }

  const scrambled = `deleted.${userId.replace(/-/g, '')}@invalid.peerpool.local`
  await supabaseAdmin.auth.admin.updateUserById(userId, {
    email: scrambled,
    password: randomBytes(24).toString('hex'),
  })
  try {
    await supabaseAdmin.auth.admin.signOut(userId, 'global')
  } catch {
    /* sessions expire with the scrambled password */
  }

  return { ok: true }
}
