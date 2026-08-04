import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

const MAX_CONTENT_LENGTH = 4000

// ============================================================
// PATCH /api/team-chat/messages/[id] — edit own message.
// DELETE /api/team-chat/messages/[id] — soft-delete own message.
//
// Both use the caller's own RLS-scoped client (not supabaseAdmin) —
// the RLS policies (team_messages_update / _delete) already enforce
// "only the author", so there's nothing a service-role bypass would
// add here except risk. If the row isn't the caller's, RLS silently
// matches zero rows rather than erroring — that surfaces as a 404
// below rather than a leaked "yes/no this belongs to someone else"
// signal.
// ============================================================

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()
    const { id } = await params

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

    const { data, error } = await supabase
      .from('team_messages')
      .update({ content_text, edited_at: new Date().toISOString() })
      .eq('id', id)
      .eq('sender_user_id', userId)
      .is('deleted_at', null)
      .select(
        'id, channel_id, sender_user_id, content_text, created_at, edited_at, deleted_at, ' +
          'source_conversation_id, source_contact_name, source_contact_phone, source_content_type, source_media_url',
      )
      .maybeSingle()

    if (error) {
      console.error('[team-chat/messages] update error:', error)
      return NextResponse.json({ error: 'Failed to edit message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Message not found, not yours, or already deleted' },
        { status: 404 },
      )
    }
    return NextResponse.json({ message: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, userId } = await getCurrentAccount()
    const { id } = await params

    // Soft delete — keeps the row (and its realtime UPDATE trail) so
    // the UI can render "message deleted" in place, same UX pattern
    // as WhatsApp's own delete-for-everyone.
    const { data, error } = await supabase
      .from('team_messages')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id)
      .eq('sender_user_id', userId)
      .is('deleted_at', null)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[team-chat/messages] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete message' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json(
        { error: 'Message not found, not yours, or already deleted' },
        { status: 404 },
      )
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
