"use server";

import { createClient } from "@/lib/supabase/server";
import { buildMediaPath } from "./media-constants";
import type { UploadAccountMediaResult } from "./media-constants";
import { r2DeleteObject, r2ObjectUrl, r2PutObject } from "./r2-client";

/**
 * Shared media-upload server actions, backed by Cloudflare R2.
 *
 * Historically this wrote to per-feature Supabase Storage buckets
 * (`flow-media`, `chat-media`) with RLS gating writes to the caller's
 * own account folder. It now stores every object in a single R2 bucket
 * (`CLOUDFLARE_R2_BUCKET`), namespaced by the same `bucket` label the
 * callers already pass in, used here as a key prefix:
 *
 *   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
 *
 * R2 has no per-object RLS, so the account scope is enforced here
 * instead: `account_id` is always resolved server-side from the
 * caller's own authenticated session, never from caller-supplied
 * input, so a signed-in user can only ever write into their own
 * account's folder. This file carries "use server" so it can be called
 * directly from client components (the Flows builder, the inbox
 * composer, the template manager) exactly as before - only the
 * constants (MEDIA_MAX_BYTES, MEDIA_MAX_BYTES_BY_KIND, buildMediaPath)
 * moved out to ./media-constants, since a "use server" file may only
 * export async functions.
 */

export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new Error("Not signed in.");
  }

  // Resolve account_id server-side from the caller's own session so the
  // upload can only ever land in their own account's folder - never a
  // caller-supplied one.
  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profileErr || !profile?.account_id) {
    throw new Error("Could not resolve your account.");
  }

  const objectPath = buildMediaPath(profile.account_id as string, file.name);
  const key = `${bucket}/${objectPath}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  await r2PutObject(key, bytes, file.type || "application/octet-stream");
  const publicUrl = await r2ObjectUrl(key);

  return { publicUrl, path: objectPath };
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent - a cancelled draft or a failed Meta send -
 * so abandoned attachments don't accumulate in the bucket.
 *
 * Best-effort: callers fire-and-forget and swallow errors (a missed
 * delete is a storage nit, not something to surface to the user).
 */
export async function deleteAccountMedia(
  bucket: string,
  path: string,
): Promise<void> {
  await r2DeleteObject(`${bucket}/${path}`);
}
