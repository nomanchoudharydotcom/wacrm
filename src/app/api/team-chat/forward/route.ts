import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// ============================================================
// POST /api/team-chat/forward — share a customer message (text or
// media) from the Inbox into an internal team-chat channel.
//
// Takes a snapshot of the source message rather than a live
// reference: team chat renders `source_contact_name` /
// `source_content_type` / `source_media_url` directly (see
// 038_team_chat_forwards.sql), so it never needs to join back into
// `conversations`/`contacts`/`messages` — tables with their own,
// differently-scoped RLS — on every render. `source_conversation_id`
// is kept only for the "View conversation" jump link.
//
// Every step below is scoped to the caller's own account: the
// source message lookup uses the RLS-scoped client (so a foreign
// message 404s instead of leaking), and the conversation join
// additionally checks `.eq('account_id', accountId)` explicitly —
// belt-and-suspenders, same pattern as whatsapp/react/route.ts.
// ============================================================

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`team-chat-forward:${ctx.userId}`, RATE_LIMITS.teamChatSend)
  if (!limit.success) return rateLimitResponse(limit)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const channelId = typeof body.channel_id === 'string' ? body.channel_id : ''
  const messageId = typeof body.message_id === 'string' ? body.message_id : ''
  if (!channelId || !messageId) {
    return NextResponse.json(
      { error: 'channel_id and message_id are required' },
      { status: 400 },
    )
  }

  // Confirm the target channel belongs to the caller's account.
  const { data: channel } = await ctx.supabase
    .from('team_channels')
    .select('id')
    .eq('id', channelId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!channel) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
  }

  // Resolve the source message — RLS (messages_select) already
  // restricts this to the caller's account.
  const { data: message, error: msgError } = await ctx.supabase
    .from('messages')
    .select('id, conversation_id, content_type, content_text, media_url')
    .eq('id', messageId)
    .maybeSingle()
  if (msgError || !message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 })
  }

  // Explicit account check on the conversation join too (belt-and-
  // suspenders alongside RLS — see file header), plus it's how we
  // pull the contact snapshot.
  const { data: conversation, error: convError } = await ctx.supabase
    .from('conversations')
    .select('id, account_id, contact:contacts(name, phone)')
    .eq('id', message.conversation_id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (convError || !conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const contact = Array.isArray(conversation.contact)
    ? conversation.contact[0]
    : conversation.contact

  const { data: forwarded, error } = await supabaseAdmin()
    .from('team_messages')
    .insert({
      channel_id: channelId,
      sender_user_id: ctx.userId,
      content_text: message.content_text ?? '',
      source_conversation_id: conversation.id,
      source_contact_name: contact?.name ?? null,
      source_contact_phone: contact?.phone ?? null,
      source_content_type: message.content_type,
      source_media_url: message.media_url,
    })
    .select(
      'id, channel_id, sender_user_id, content_text, created_at, edited_at, deleted_at, ' +
        'source_conversation_id, source_contact_name, source_contact_phone, source_content_type, source_media_url',
    )
    .single()

  if (error) {
    console.error('[team-chat/forward] insert error:', error)
    return NextResponse.json({ error: 'Failed to forward message' }, { status: 500 })
  }
  return NextResponse.json({ message: forwarded }, { status: 201 })
}
