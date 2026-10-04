/**
 * Messaging domain helpers for PeerPool.
 *
 * Layer: service. All DB/Storage writes use `supabaseAdmin`. Clients never
 * upload without a prepared signed URL and never insert rows directly.
 * Chat attachments: images only (re-encoded to WebP on send).
 *
 * See `.cursor/rules/messaging.mdc` for the end-to-end contract.
 */

import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from './supabase.js'
import { processChatImage } from './imageCompression.js'
import { messageAllowedForViewer, messageHideSets } from './moderation.js'

/** Private Supabase Storage bucket for chat attachments. */
export const CHAT_MEDIA_BUCKET = 'chat-media'

/** Edit and soft-delete allowed within this many ms after `created_at`. */
export const MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000

/** Max upload size for image MIME types (pre-compression). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

/** Attachment metadata sent with POST message after client upload. */
export type AttachmentInput = {
  storagePath: string
  mimeType: string
  sizeBytes: number
  fileName: string
}

/**
 * Check whether a MIME type is allowed for chat attachments (images only).
 */
export function isAllowedMime(mime: string): boolean {
  return IMAGE_MIMES.has(mime)
}

/**
 * Return max byte size for a given MIME type.
 */
export function maxBytesForMime(_mime: string): number {
  return MAX_IMAGE_BYTES
}

/**
 * Validate attachment metadata before prepare-upload or send.
 */
export function validateAttachmentMeta(input: {
  mimeType: string
  sizeBytes: number
  fileName: string
}): string | null {
  if (!input.fileName?.trim()) return 'fileName is required'
  if (!isAllowedMime(input.mimeType)) return 'Only images are allowed'
  const max = maxBytesForMime(input.mimeType)
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
    return 'Invalid file size'
  }
  if (input.sizeBytes > max) {
    return `File exceeds max size (${max} bytes)`
  }
  return null
}

/**
 * Check whether a message is still within the 15-minute edit/delete window.
 */
export function withinEditWindow(createdAt: string): boolean {
  const created = new Date(createdAt).getTime()
  return Date.now() - created <= MESSAGE_EDIT_WINDOW_MS
}

/** Last-message row for conversation list previews. */
export type ConversationPreviewMessage = {
  id: string
  conversation_id: string
  body: string | null
  created_at: string
  sender_id: string
  deleted_at: string | null
  moderation_hidden_at: string | null
}

const LAST_MESSAGE_PAGE = 1000
const LAST_MESSAGE_PER_CONV = 20

const MESSAGE_PREVIEW_SELECT =
  'id, conversation_id, body, created_at, sender_id, deleted_at, moderation_hidden_at'
const MESSAGE_PREVIEW_SELECT_LEGACY =
  'id, conversation_id, body, created_at, sender_id, deleted_at'

/** False after the connected DB is shown to lack `messages.moderation_hidden_at`. */
let messagesHaveModerationHidden = true

function previewSelect(): string {
  return messagesHaveModerationHidden ? MESSAGE_PREVIEW_SELECT : MESSAGE_PREVIEW_SELECT_LEGACY
}

function noteMissingModerationColumn(err: { message?: string } | null | undefined): boolean {
  if (err?.message?.includes('moderation_hidden_at')) {
    messagesHaveModerationHidden = false
    return true
  }
  return false
}

export const MESSAGE_THREAD_SELECT =
  'id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, reply_to_id, moderation_hidden_at'
export const MESSAGE_THREAD_SELECT_LEGACY =
  'id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, reply_to_id'

/** Columns for GET /conversations/:id/messages (legacy DB may lack hide stamp). */
export function messageThreadSelect(): string {
  return messagesHaveModerationHidden ? MESSAGE_THREAD_SELECT : MESSAGE_THREAD_SELECT_LEGACY
}

/** @returns true when the error is the missing hide column (caller should retry). */
export function shouldRetryWithoutModerationHidden(
  err: { message?: string } | null | undefined,
): boolean {
  return noteMissingModerationColumn(err)
}

/**
 * One visible last message per conversation.
 * A single newest-first `.in()` page can miss older chats (PostgREST row cap);
 * those ids get a per-conversation follow-up.
 */
export async function lastVisibleMessagesByConversationIds(
  conversationIds: string[],
  viewerUserId: string,
  onError?: (err: unknown, context: string) => void,
): Promise<Map<string, ConversationPreviewMessage>> {
  const lastByConv = new Map<string, ConversationPreviewMessage>()
  if (conversationIds.length === 0) return lastByConv

  const hideSets = await messageHideSets(viewerUserId)

  const runPage = () =>
    supabaseAdmin
      .from('messages')
      .select(previewSelect())
      .in('conversation_id', conversationIds)
      .order('created_at', { ascending: false })
      .limit(LAST_MESSAGE_PAGE)

  let { data: recent, error } = await runPage()
  if (shouldRetryWithoutModerationHidden(error)) {
    ;({ data: recent, error } = await runPage())
  }

  if (error) {
    onError?.(error, 'lastVisibleMessagesByConversationIds page')
  } else {
    for (const msg of recent ?? []) {
      const row = msg as unknown as ConversationPreviewMessage
      if (lastByConv.has(row.conversation_id)) continue
      if (row.deleted_at) continue
      if (!messageAllowedForViewer(row, viewerUserId, hideSets.personal, hideSets.global)) {
        continue
      }
      lastByConv.set(row.conversation_id, row)
    }
  }

  const missing = conversationIds.filter((id) => !lastByConv.has(id))
  await Promise.all(
    missing.map(async (id) => {
      const runFollow = () =>
        supabaseAdmin
          .from('messages')
          .select(previewSelect())
          .eq('conversation_id', id)
          .order('created_at', { ascending: false })
          .limit(LAST_MESSAGE_PER_CONV)
      let { data, error: followErr } = await runFollow()
      if (shouldRetryWithoutModerationHidden(followErr)) {
        ;({ data, error: followErr } = await runFollow())
      }
      if (followErr) {
        onError?.(followErr, `lastVisibleMessagesByConversationIds ${id}`)
        return
      }
      for (const msg of data ?? []) {
        const row = msg as unknown as ConversationPreviewMessage
        if (row.deleted_at) continue
        if (!messageAllowedForViewer(row, viewerUserId, hideSets.personal, hideSets.global)) {
          continue
        }
        lastByConv.set(id, row)
        break
      }
    }),
  )

  return lastByConv
}

/**
 * Verify that a user is a member of a conversation.
 */
export async function assertMember(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('conversation_members')
    .select('user_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .limit(1)

  if (error) throw error
  return Boolean(data?.[0])
}

/**
 * Sanitize a filename for Storage object keys.
 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file'
}

/**
 * Build a Storage object path for a chat attachment.
 */
export function buildStoragePath(input: {
  conversationId: string
  userId: string
  clientId: string
  fileName: string
}): string {
  const safe = sanitizeFileName(input.fileName)
  return `${input.conversationId}/${input.userId}/${input.clientId}/${randomUUID()}_${safe}`
}

/**
 * Create a signed upload URL for `chat-media` bucket.
 */
export async function createSignedUpload(storagePath: string) {
  const { data, error } = await supabaseAdmin.storage
    .from(CHAT_MEDIA_BUCKET)
    .createSignedUploadUrl(storagePath)

  if (error) throw error
  return data
}

/**
 * Create a time-limited signed download URL for a stored attachment.
 */
export async function createSignedDownloadUrl(storagePath: string, expiresIn = 3600) {
  const { data, error } = await supabaseAdmin.storage
    .from(CHAT_MEDIA_BUCKET)
    .createSignedUrl(storagePath, expiresIn)

  if (error) throw error
  return data.signedUrl
}

/**
 * Check whether a Storage object exists at the given path.
 */
export async function storageObjectExists(storagePath: string): Promise<boolean> {
  const dir = storagePath.includes('/')
    ? storagePath.slice(0, storagePath.lastIndexOf('/'))
    : ''
  const fileName = storagePath.includes('/')
    ? storagePath.slice(storagePath.lastIndexOf('/') + 1)
    : storagePath

  const { data, error } = await supabaseAdmin.storage
    .from(CHAT_MEDIA_BUCKET)
    .list(dir, { search: fileName, limit: 20 })

  if (error) throw error
  return (data ?? []).some((f) => f.name === fileName)
}

/**
 * Verify attachment path belongs to the sender's prepared upload prefix.
 */
export function assertAttachmentPathOwned(input: {
  storagePath: string
  conversationId: string
  userId: string
  clientId: string
}): boolean {
  const prefix = `${input.conversationId}/${input.userId}/${input.clientId}/`
  return input.storagePath.startsWith(prefix)
}

/**
 * Download uploaded image, re-encode to WebP (max 1280), replace in Storage.
 * Returns final storage path / mime / size for DB insert.
 */
export async function reencodeChatImageAttachment(input: {
  storagePath: string
  fileName: string
}): Promise<{ storagePath: string; mimeType: string; sizeBytes: number; fileName: string }> {
  const { data, error } = await supabaseAdmin.storage
    .from(CHAT_MEDIA_BUCKET)
    .download(input.storagePath)

  if (error || !data) throw error ?? new Error('Could not download attachment')

  const arrayBuf = await data.arrayBuffer()
  const webp = await processChatImage(Buffer.from(arrayBuf))

  const dir = input.storagePath.includes('/')
    ? input.storagePath.slice(0, input.storagePath.lastIndexOf('/'))
    : ''
  const webpPath = `${dir}/${randomUUID()}.webp`

  const { error: upError } = await supabaseAdmin.storage
    .from(CHAT_MEDIA_BUCKET)
    .upload(webpPath, webp, { contentType: 'image/webp', upsert: false })

  if (upError) throw upError

  // Best-effort remove original upload
  await supabaseAdmin.storage.from(CHAT_MEDIA_BUCKET).remove([input.storagePath])

  const baseName = sanitizeFileName(input.fileName.replace(/\.[^.]+$/, '') || 'image')
  return {
    storagePath: webpPath,
    mimeType: 'image/webp',
    sizeBytes: webp.length,
    fileName: `${baseName}.webp`,
  }
}
