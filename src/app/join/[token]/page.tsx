'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
  /** Set when the admin bound this invite to a specific address
   *  (migration 039). Null for legacy unrestricted invites. */
  email: string | null;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

const ROLE_LABEL: Record<PeekOk['role'], string> = {
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};

const FAIL_COPY: Record<PeekFail['reason'], { title: string; body: string }> = {
  not_found: {
    title: 'Invite not found',
    body: 'This link doesn’t match a valid invitation. Double-check the URL or ask the person who invited you to send a new one.',
  },
  used: {
    title: 'Invite already used',
    body: 'This invitation has already been accepted. If that wasn’t you, ask the account admin to send a fresh link.',
  },
  expired: {
    title: 'Invite expired',
    body: 'This invitation has expired. Ask the account admin to send a new one — they take a few seconds to generate.',
  },
  server_error: {
    title: 'Something went wrong',
    body: 'We couldn’t verify this invitation right now. Try refreshing the page in a moment.',
  },
};

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` and `/signup` do.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [authedUserEmail, setAuthedUserEmail] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Quick-join form — shown instead of the signup/login links when
  // the invite is email-locked, so a new teammate can go straight
  // from "opened the link" to "logged in" without an email round
  // trip (see /api/invitations/[token]/join).
  const [joinFullName, setJoinFullName] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [joinConfirmPassword, setJoinConfirmPassword] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // Once the join endpoint returns "account already exists," quick-join
  // can't proceed — fall back to the existing sign-in flow instead of
  // leaving the visitor stuck on a dead-end error.
  const [joinAccountExists, setJoinAccountExists] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
      setAuthedUserEmail(authRes.data.user?.email ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
      setAuthedUserEmail(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
        setAuthedUserEmail(authRes.data.user?.email ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
        setAuthedUserEmail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleQuickJoin = useCallback(
    async (e: React.FormEvent, targetEmail: string) => {
      e.preventDefault();
      if (!token) return;
      setJoinError(null);

      if (!joinFullName.trim()) {
        setJoinError('Enter your full name');
        return;
      }
      if (joinPassword.length < 6) {
        setJoinError('Password must be at least 6 characters');
        return;
      }
      if (joinPassword !== joinConfirmPassword) {
        setJoinError('Passwords do not match');
        return;
      }

      setJoining(true);
      try {
        const res = await fetch(
          `/api/invitations/${encodeURIComponent(token)}/join`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fullName: joinFullName.trim(),
              password: joinPassword,
            }),
          },
        );

        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          if (res.status === 409 && payload.error?.toLowerCase().includes('already exists')) {
            setJoinAccountExists(true);
          } else {
            setJoinError(payload.error || 'Failed to join');
          }
          setJoining(false);
          return;
        }

        // The admin API that created this user doesn't hand back a
        // browser session — sign in with the password just set so
        // the client picks up cookies the same way a normal login
        // would.
        const { error: signInError } = await createClient().auth.signInWithPassword({
          email: targetEmail,
          password: joinPassword,
        });
        if (signInError) {
          console.error('[join] post-create sign-in error:', signInError);
          toast.error('Account created — please sign in.');
          window.location.href = `/login?invite=${encodeURIComponent(token)}`;
          return;
        }

        toast.success('Welcome to the team');
        window.location.href = '/dashboard';
      } catch (err) {
        console.error('[join] quick-join error:', err);
        setJoinError('Could not reach the server. Try again?');
        setJoining(false);
      }
    },
    [token, joinFullName, joinPassword, joinConfirmPassword],
  );

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use different email)
        // rather than a 3-second toast.
        if (res.status === 409) {
          setConflictMessage(
            payload.error ||
              'You are already in another account. Sign in with a different email to join this one.',
          );
        } else {
          toast.error(payload.error || 'Failed to accept invitation');
        }
        setAccepting(false);
        return;
      }
      toast.success('Welcome to the team');
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error('Could not reach the server');
      setAccepting(false);
    }
  }, [token]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error('Could not sign out. Try refreshing the page.');
      setSigningOut(false);
    }
  }, []);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Verifying invitation…</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const copy = FAIL_COPY[peek.reason];
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">{copy.title}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {copy.body}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is
              the right primary action; the "create account" /
              "sign in" links stay as secondary options. Other
              failure reasons (not_found / used / expired) are
              terminal for this token, so no retry — just the
              signup/sign-in escape hatches. */}
          {peek.reason === 'server_error' ? (
            <>
              <Button
                onClick={loadPeekAndAuth}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Try again
              </Button>
              <Link href="/signup">
                <Button
                  variant="outline"
                  className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Create a new account instead
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup">
                <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                  Create a new account instead
                </Button>
              </Link>
              <Link href="/login">
                <Button
                  variant="outline"
                  className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Sign in
                </Button>
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <UsersRound className="h-6 w-6 text-primary" />
      </div>
      <CardTitle className="text-xl text-foreground">
        You&apos;re invited to{' '}
        <span className="text-primary">{peek.account_name}</span>
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        You&apos;ll join as{' '}
        <span className="inline-flex items-center gap-1 text-foreground">
          <ShieldCheck className="size-3.5 text-primary" />
          {ROLE_LABEL[peek.role]}
        </span>
        . Link valid until{' '}
        {new Date(peek.expires_at).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}
        .
        {peek.email && (
          <>
            {' '}This invite is locked to{' '}
            <span className="text-foreground">{peek.email}</span>.
          </>
        )}
      </CardDescription>
    </CardHeader>
  );

  // If the invite is email-locked and the signed-in visitor's own
  // address doesn't match, block Accept up front instead of letting
  // them hit the RPC's refusal — same info, friendlier next step.
  const emailMismatch =
    !!peek.email &&
    !!authedUserEmail &&
    peek.email.toLowerCase() !== authedUserEmail.toLowerCase();

  // ----- Authed: show Accept button (or the email-mismatch notice) -----
  if (authedUserId) {
    return (
      <>
        <Card className="w-full max-w-md border-border bg-card">
          {inviteHeader}
          <CardContent className="flex flex-col gap-3">
            {emailMismatch ? (
              <>
                <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
                  <span>
                    You&apos;re signed in as{' '}
                    <span className="text-amber-100">{authedUserEmail}</span>, but
                    this invite is for{' '}
                    <span className="text-amber-100">{peek.email}</span>. Sign out
                    and sign in with that address to accept.
                  </span>
                </div>
                <Button
                  variant="outline"
                  onClick={handleSignOutAndRetry}
                  disabled={signingOut}
                  className="w-full border-border text-muted-foreground hover:bg-muted"
                >
                  {signingOut ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Signing out…
                    </>
                  ) : (
                    'Sign out & use a different email'
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={handleAccept}
                  disabled={accepting}
                  className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {accepting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Accepting…
                    </>
                  ) : (
                    <>
                      <CheckCircle className="size-4" />
                      Accept invitation
                    </>
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  Accepting moves your login into{' '}
                  <span className="text-muted-foreground">{peek.account_name}</span>. Your
                  empty personal account from signup will be cleaned up.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Conflict modal — opens when the redeem endpoint returns 409
            (caller already in a shared account or has domain data).
            Blocks the flow until the user picks a recovery action so
            they aren't stuck retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 text-amber-400" />
                Can&apos;t join {peek.account_name} with this account
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              <p>
                To join{' '}
                <span className="text-popover-foreground">{peek.account_name}</span>,
                sign out and sign up again with a different email address.
                The invite link stays valid as long as it hasn&apos;t
                expired.
              </p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => setConflictMessage(null)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                Stay signed in
              </Button>
              <Button
                onClick={handleSignOutAndRetry}
                disabled={signingOut}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Signing out…
                  </>
                ) : (
                  'Sign out & use a different email'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed -----
  // Carry the locked email through as a query param so the signup/
  // login pages can prefill + lock the field on the fallback path.
  const emailParam = peek.email
    ? `&email=${encodeURIComponent(peek.email)}`
    : '';

  // Quick join: the invite already tells us exactly who this is, so
  // skip the signup-then-verify-then-redeem round trip and just ask
  // for a name + password right here. Falls back to the classic
  // signup/login links for legacy invites with no email lock, or
  // once we've learned an account already exists for this address.
  if (peek.email && !joinAccountExists) {
    const targetEmail = peek.email;
    return (
      <Card className="w-full max-w-md border-border bg-card">
        {inviteHeader}
        <CardContent>
          <form
            onSubmit={(e) => handleQuickJoin(e, targetEmail)}
            className="flex flex-col gap-4"
          >
            {joinError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                {joinError}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="joinFullName" className="text-muted-foreground">
                Full name
              </Label>
              <Input
                id="joinFullName"
                type="text"
                placeholder="John Doe"
                value={joinFullName}
                onChange={(e) => setJoinFullName(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">Email</Label>
              <Input
                type="email"
                value={targetEmail}
                readOnly
                className="border-border bg-muted text-foreground opacity-70"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="joinPassword" className="text-muted-foreground">
                Password
              </Label>
              <Input
                id="joinPassword"
                type="password"
                placeholder="At least 6 characters"
                value={joinPassword}
                onChange={(e) => setJoinPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="joinConfirmPassword" className="text-muted-foreground">
                Confirm password
              </Label>
              <Input
                id="joinConfirmPassword"
                type="password"
                placeholder="Repeat your password"
                value={joinConfirmPassword}
                onChange={(e) => setJoinConfirmPassword(e.target.value)}
                required
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <Button
              type="submit"
              disabled={joining}
              className="mt-1 w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {joining ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Joining…
                </>
              ) : (
                'Set password & join'
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground">
              Already have a wacrm account with this email?{' '}
              <button
                type="button"
                onClick={() => setJoinAccountExists(true)}
                className="text-primary hover:text-primary/80"
              >
                Sign in instead
              </button>
            </p>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md border-border bg-card">
      {inviteHeader}
      <CardContent className="flex flex-col gap-2">
        {joinAccountExists && (
          <p className="mb-1 text-center text-xs text-muted-foreground">
            An account already exists for {peek.email} — sign in to accept.
          </p>
        )}
        {!joinAccountExists && (
          <Link href={`/signup?invite=${encodeURIComponent(token!)}${emailParam}`}>
            <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              Create account &amp; join
            </Button>
          </Link>
        )}
        <Link href={`/login?invite=${encodeURIComponent(token!)}${emailParam}`}>
          <Button
            className={
              joinAccountExists
                ? 'w-full bg-primary text-primary-foreground hover:bg-primary/90'
                : 'w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground'
            }
            variant={joinAccountExists ? 'default' : 'outline'}
          >
            I already have an account
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
