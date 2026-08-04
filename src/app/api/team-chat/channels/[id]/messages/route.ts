import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

const MAX_CONTENT_LENGTH = 4000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100

// ============================================================
// GET /api/team-chat/channels/[id]/messages — list a channel's
// messages, newest first. `before` is an ISO timestamp cursor (pass
// the oldest `created_at` you already have to load older history).
//
// POST — send a message into the channel. Rate-limited per user;
// account/role check happens here for a clean 403/404 rather than
// relying solely on the RLS insert failure (which RLS still backs
// up regardless — see 037_team_chat.sql).
// ============================================================

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id: channelId } = await params

    const url = new URL(request.url)
    const before = url.searchParams.get('before')
    const limitParam = Number(url.searchParams.get('limit'))
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, MAX_LIMIT)
        : DEFAULT_LIMIT

    // Verify the channel belongs to the caller's account (RLS would
    // also block a foreign channel_id on the messages join, but this
    // gives a clean 404 instead of an empty list for a typo'd id).
    const { data: channel } = await supabase
      .from('team_channels')
      .select('id')
      .eq('id', channelId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!channel) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    let query = supabase
      .from('team_messages')
      .select('id, channel_id, sender_user_id, content_text, created_at, edited_at, deleted_at')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (before) query = query.lt('created_at', before)

    const { data, error } = await query
    if (error) {
      console.error('[team-chat/messages] list error:', error)
      return NextResponse.json({ error: 'Failed to list messages' }, { status: 500 })
    }

    return NextResponse.json({ messages: (data ?? []).reverse() })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`team-chat-send:${ctx.userId}`, RATE_LIMITS.teamChatSend)
  if (!limit.success) return rateLimitResponse(limit)

  const { id: channelId } = await params

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const content_text = typeof body.content_text === 'string' ? body.content_text.trim() : ''
  if (!content_text) {
    return NextResponse.json({ error: 'content_text is required' }, { status: 400 })
  }
  if (content_text.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json(
      { error: `content_text must be ${MAX_CONTENT_LENGTH} characters or fewer` },
      { status: 400 },
    )
  }

  // Confirm the channel belongs to the caller's account before
  // writing — same reasoning as the GET handler above.
  const { data: channel } = await ctx.supabase
    .from('team_channels')
    .select('id')
    .eq('id', channelId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!channel) {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
  }

  const { data, error } = await supabaseAdmin()
    .from('team_messages')
    .insert({
      channel_id: channelId,
      sender_user_id: ctx.userId,
      content_text,
    })
    .select('id, channel_id, sender_user_id, content_text, created_at, edited_at, deleted_at')
    .single()

  if (error) {
    console.error('[team-chat/messages] insert error:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
  return NextResponse.json({ message: data }, { status: 201 })
}
