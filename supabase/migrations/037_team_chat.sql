-- ============================================================
-- 037_team_chat.sql — Internal team chat (channels + messages)
--
-- Account-wide group channels for internal team communication,
-- kept entirely separate from customer WhatsApp conversations
-- (different tables, different RLS, different realtime channel).
--
-- v1 scope, deliberately kept small:
--   - Every member of an account can see and post in every channel
--     belonging to that account. No per-channel membership table —
--     that's real complexity (extra joins, extra RLS, extra states
--     to get wrong) for a feature nobody asked for yet. If private/
--     restricted channels are needed later, add a
--     `team_channel_members` table and tighten the SELECT/INSERT
--     policies below to check it — nothing here has to be redesigned
--     for that, only extended.
--   - One default "General" channel per account, auto-created for
--     every new signup and backfilled for existing accounts.
--   - Messages can be edited/soft-deleted by their own author only.
--     No admin moderation override in v1 (mirrors how nobody else
--     can edit your WhatsApp-side messages either).
--
-- Mirrors the account-scoping pattern from 017_account_sharing.sql:
-- is_account_member(account_id, min_role) gates every policy, same
-- as every other account-scoped table in this codebase.
--
-- Idempotent — safe to run multiple times (IF NOT EXISTS / DROP-then-
-- CREATE POLICY), consistent with every other migration in this repo.
-- ============================================================

-- ============================================================
-- TEAM_CHANNELS
-- ============================================================
CREATE TABLE IF NOT EXISTS team_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_channels_account ON team_channels(account_id);

-- At most one default ("General") channel per account — the seed
-- below and the signup trigger both rely on this to stay idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_channels_one_default
  ON team_channels(account_id) WHERE is_default;

ALTER TABLE team_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_channels_select ON team_channels;
DROP POLICY IF EXISTS team_channels_insert ON team_channels;
DROP POLICY IF EXISTS team_channels_update ON team_channels;
DROP POLICY IF EXISTS team_channels_delete ON team_channels;

CREATE POLICY team_channels_select ON team_channels FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY team_channels_insert ON team_channels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY team_channels_update ON team_channels FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
-- The default "General" channel can't be deleted — always leaves the
-- account with somewhere for the team to talk.
CREATE POLICY team_channels_delete ON team_channels FOR DELETE
  USING (is_account_member(account_id, 'admin') AND NOT is_default);

-- ============================================================
-- TEAM_MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS team_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  channel_id UUID NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_team_messages_channel_created
  ON team_messages(channel_id, created_at DESC);

-- Full replica identity so realtime UPDATE payloads (edit / soft-
-- delete) include the prior column values — same reasoning as the
-- notifications table in 027_notifications.sql.
ALTER TABLE team_messages REPLICA IDENTITY FULL;

ALTER TABLE team_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS team_messages_select ON team_messages;
DROP POLICY IF EXISTS team_messages_insert ON team_messages;
DROP POLICY IF EXISTS team_messages_update ON team_messages;
DROP POLICY IF EXISTS team_messages_delete ON team_messages;

CREATE POLICY team_messages_select ON team_messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM team_channels tc
    WHERE tc.id = team_messages.channel_id
      AND is_account_member(tc.account_id)
  )
);
-- INSERT requires both: caller must be posting as themselves (can't
-- spoof another teammate as the sender), and must be at least an
-- agent in the channel's account.
CREATE POLICY team_messages_insert ON team_messages FOR INSERT WITH CHECK (
  sender_user_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM team_channels tc
    WHERE tc.id = team_messages.channel_id
      AND is_account_member(tc.account_id, 'agent')
  )
);
-- Only the author may edit or soft-delete their own message — no
-- admin override in v1 (see header note).
CREATE POLICY team_messages_update ON team_messages FOR UPDATE
  USING (sender_user_id = auth.uid())
  WITH CHECK (sender_user_id = auth.uid());
CREATE POLICY team_messages_delete ON team_messages FOR DELETE
  USING (sender_user_id = auth.uid());

-- ============================================================
-- BACKFILL — starter channels per existing account
--
-- "General" is the protected default (can't be deleted — see the
-- team_channels_delete policy above). Sales / Support / Billing are
-- ordinary channels seeded as a starting point; the owner/admin can
-- rename, delete, or add more from the UI like any other channel.
-- ============================================================
INSERT INTO team_channels (account_id, name, is_default)
SELECT a.id, 'General', true
FROM accounts a
WHERE NOT EXISTS (
  SELECT 1 FROM team_channels tc WHERE tc.account_id = a.id AND tc.is_default
);

INSERT INTO team_channels (account_id, name, is_default)
SELECT a.id, ch.name, false
FROM accounts a
CROSS JOIN (VALUES ('Sales'), ('Support'), ('Billing')) AS ch(name)
WHERE NOT EXISTS (
  SELECT 1 FROM team_channels tc
  WHERE tc.account_id = a.id AND tc.name = ch.name
);

-- ============================================================
-- SIGNUP TRIGGER — extend handle_new_user to seed starter channels
--
-- Re-creates the function from 017_account_sharing.sql with one
-- addition: the same four starter channels for the freshly-created
-- account. CREATE OR REPLACE swaps the function body in place; the
-- existing `on_auth_user_created` trigger (created in 017) keeps
-- pointing at it, so no DROP/CREATE TRIGGER needed here.
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');

  INSERT INTO public.team_channels (account_id, name, is_default, created_by_user_id)
  VALUES (v_account_id, 'General', true, NEW.id);

  INSERT INTO public.team_channels (account_id, name, is_default, created_by_user_id)
  VALUES (v_account_id, 'Sales', false, NEW.id),
         (v_account_id, 'Support', false, NEW.id),
         (v_account_id, 'Billing', false, NEW.id);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ============================================================
-- ENABLE REALTIME
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'team_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE team_messages;
  END IF;
END $$;
