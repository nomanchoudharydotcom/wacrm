import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Internal team chat — channels. GET lists every channel for the
// caller's account (RLS-scoped read via the user client, mirrors
// quick-replies/route.ts); POST creates a new channel (agent+, same
// tier as other operational-data writes like sending a message).
//
// account_id / created_by_user_id are always taken from the server-
// resolved session (ctx), never from the request body — a client
// can't create a channel in someone else's account by guessing an id.

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    // RLS (team_channels_select) scopes to the caller's account.
    const { data, error } = await supabase
      .from('team_channels')
      .select('id, name, is_default, created_at')
      .order('is_default', { ascending: false })
      .order('name', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ channels: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('agent')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (name.length > 80) {
    return NextResponse.json({ error: 'name must be 80 characters or fewer' }, { status: 400 })
  }

  const { data, error } = await supabaseAdmin()
    .from('team_channels')
    .insert({
      account_id: ctx.accountId,
      name,
      is_default: false,
      created_by_user_id: ctx.userId,
    })
    .select('id, name, is_default, created_at')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ channel: data }, { status: 201 })
}
