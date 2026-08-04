-- ============================================================
-- 038_team_chat_forwards.sql — forward a customer message into
-- team chat.
--
-- Adds a small "source" snapshot to team_messages so a forwarded
-- customer message renders standalone in team chat, without team
-- chat needing to join into `conversations`/`contacts`/`messages`
-- (which have their own, differently-scoped RLS) every render.
--
-- source_conversation_id is kept as a live FK purely for the
-- "View conversation" link (jumps to /inbox?c=<id>). If the
-- conversation is later deleted, ON DELETE SET NULL just drops the
-- link — the forwarded snapshot (name/phone/content) still stands
-- on its own, same reasoning as a soft-delete leaving a trail.
--
-- No RLS changes needed: these are plain nullable columns on a
-- table whose policies (037_team_chat.sql) already gate every
-- row by account membership. The forward API route (not this
-- migration) is what verifies the source conversation belongs to
-- the caller's account before writing.
-- ============================================================

ALTER TABLE team_messages
  ADD COLUMN IF NOT EXISTS source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS source_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS source_content_type TEXT,
  ADD COLUMN IF NOT EXISTS source_media_url TEXT;

CREATE INDEX IF NOT EXISTS idx_team_messages_source_conversation
  ON team_messages(source_conversation_id)
  WHERE source_conversation_id IS NOT NULL;
