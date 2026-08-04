// ============================================================
// POST /api/invitations/[token]/join
//
// One-step "quick join" for invites that are locked to a specific
// email (migration 039). Public — no auth required, since the
// visitor doesn't have a session yet. Instead of the normal
// signUp → confirmation email → click link → redeem round trip,
// this:
//
//   1. Validates the invite (found, not used, not expired, has an
//      email lock — legacy unrestricted invites fall back to the
//      slower /signup flow on the client, see join/[token]/page.tsx).
//   2. Creates the auth user via the admin API with
//      `email_confirm: true`, so no verification email is sent and
//      the account is immediately usable.
//   3. Moves that user straight into the invite's account via
//      `redeem_invitation_as` (migration 040), the service-role
//      counterpart of `redeem_invitation` that takes the user id as
//      a parameter instead of reading it off a session.
//
// The client then signs in with the password it just set (the admin
// API doesn't hand back a session) and redirects to /dashboard.
//
// Privilege note: nothing in the request body influences which
// account or role the caller ends up with — those come entirely
// from the invitation row looked up by token. The body only
// supplies `fullName` and `password`, both of which only affect the
// new user's own profile/credentials.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const ip = getClientIp(request);
  const limit = checkRateLimit(`join:${ip}`, RATE_LIMITS.invitationJoin);
  if (!limit.success) return rateLimitResponse(limit);

  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json(
      { error: "Missing invitation token" },
      { status: 400 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { fullName?: unknown; password?: unknown }
    | null;

  const fullName =
    typeof body?.fullName === "string" ? body.fullName.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!fullName) {
    return NextResponse.json(
      { error: "Full name is required" },
      { status: 400 },
    );
  }
  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  const tokenHash = hashInviteToken(token);

  const { data: invitation, error: invError } = await admin
    .from("account_invitations")
    .select("id, email, accepted_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (invError) {
    console.error("[join] invitation lookup error:", invError);
    return NextResponse.json(
      { error: "Failed to look up invitation" },
      { status: 500 },
    );
  }
  if (!invitation) {
    return NextResponse.json(
      { error: "Invitation not found" },
      { status: 404 },
    );
  }
  if (invitation.accepted_at) {
    return NextResponse.json(
      { error: "This invitation has already been used" },
      { status: 409 },
    );
  }
  if (new Date(invitation.expires_at) <= new Date()) {
    return NextResponse.json(
      { error: "This invitation has expired" },
      { status: 410 },
    );
  }
  if (!invitation.email) {
    // Legacy unrestricted invite from before migration 039 — no
    // known email to create the account against. The client falls
    // back to the full /signup flow for this case; reaching here
    // means it called the wrong endpoint.
    return NextResponse.json(
      { error: "This invitation doesn't support quick join" },
      { status: 400 },
    );
  }

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: invitation.email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

  if (createError || !created?.user) {
    // Supabase surfaces "already registered" as a 422/400 with a
    // recognizable message — map that to a friendly conflict so the
    // client can point the visitor at the sign-in flow instead of a
    // generic error.
    const alreadyExists =
      createError?.message?.toLowerCase().includes("already") ?? false;
    if (alreadyExists) {
      return NextResponse.json(
        {
          error:
            "An account with this email already exists. Sign in instead to accept the invite.",
        },
        { status: 409 },
      );
    }
    console.error("[join] createUser error:", createError);
    return NextResponse.json(
      { error: "Failed to create account" },
      { status: 500 },
    );
  }

  const { error: redeemError } = await admin.rpc("redeem_invitation_as", {
    p_token_hash: tokenHash,
    p_user_id: created.user.id,
  });

  if (redeemError) {
    // The auth user now exists (with an empty personal account from
    // the handle_new_user trigger) but didn't get moved into the
    // team account — e.g. someone else redeemed the same invite in
    // the split second between our validation above and this call.
    // We don't roll back the created user: it's a normal, usable
    // (if orphaned) account, no different from any signup that never
    // finishes joining a team today.
    console.error("[join] redeem_invitation_as error:", redeemError);
    return NextResponse.json(
      { error: redeemError.message || "Failed to join the account" },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, email: invitation.email }, { status: 201 });
}
