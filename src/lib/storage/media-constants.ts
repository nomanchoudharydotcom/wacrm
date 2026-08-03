/**
 * Pure constants + helpers for the account-media storage feature
 * (WhatsApp message attachments, template header media, Flow media).
 *
 * Kept in a plain module (no "use server"/"use client" directive) so it
 * can be imported from both client components (for pre-upload size
 * checks) and the upload-media.ts server action (which cannot itself
 * export non-async values once it carries "use server").
 */

/** 16 MB - the overall ceiling; per-kind caps below are tighter for images. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/** Per-kind caps used by the inbox composer (mirrors Meta's own attachment limits). */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/**
 * Build the account-scoped object key for an upload. Pure + exported so
 * it can be unit-tested without a network client.
 *
 * - `fileName`'s extension is lower-cased; the base name has unsafe
 *   chars collapsed to `_` and is capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** URL Meta (or the browser) can fetch at send time. */
  publicUrl: string;
  /** Storage object key, scoped under the caller's bucket label + account folder. */
  path: string;
}
