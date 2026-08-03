import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 client (S3-compatible API). R2 has no regions of its own
 * - "auto" lets Cloudflare route to wherever the bucket actually lives.
 *
 * Required env vars:
 *   CLOUDFLARE_R2_ACCOUNT_ID        - Cloudflare account ID
 *   CLOUDFLARE_R2_ACCESS_KEY_ID     - R2 API token Access Key ID
 *   CLOUDFLARE_R2_SECRET_ACCESS_KEY - R2 API token Secret Access Key
 *   CLOUDFLARE_R2_BUCKET            - bucket name (e.g. wacrm-media)
 *
 * Optional:
 *   CLOUDFLARE_R2_PUBLIC_URL        - public base URL if the bucket has a
 *                                     custom domain or the r2.dev public
 *                                     access URL enabled, e.g.
 *                                     https://media.worldlinktechservices.com
 *                                     or https://pub-xxxx.r2.dev. When
 *                                     unset, object URLs fall back to a
 *                                     7-day presigned GET URL instead -
 *                                     no public bucket access required at
 *                                     all, which is the safer default for
 *                                     a self-hosted setup.
 *
 * Server-only: this module touches the secret access key, so it must
 * never be imported from a "use client" component.
 */
let cachedClient: S3Client | null = null;

function getR2Client(): S3Client {
  if (cachedClient) return cachedClient;

  const accountId = process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  const accessKeyId = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Cloudflare R2 is not configured. Set CLOUDFLARE_R2_ACCOUNT_ID, " +
        "CLOUDFLARE_R2_ACCESS_KEY_ID and CLOUDFLARE_R2_SECRET_ACCESS_KEY.",
    );
  }

  cachedClient = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

function getR2Bucket(): string {
  const bucket = process.env.CLOUDFLARE_R2_BUCKET;
  if (!bucket) {
    throw new Error("Cloudflare R2 is not configured. Set CLOUDFLARE_R2_BUCKET.");
  }
  return bucket;
}

/** Upload a buffer to R2 under `key`. */
export async function r2PutObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({
      Bucket: getR2Bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

/** Delete an object from R2. Idempotent - a missing key is not an error. */
export async function r2DeleteObject(key: string): Promise<void> {
  const client = getR2Client();
  await client.send(new DeleteObjectCommand({ Bucket: getR2Bucket(), Key: key }));
}

/**
 * Resolve a URL Meta (or the browser) can fetch the object from.
 *
 * If CLOUDFLARE_R2_PUBLIC_URL is set, objects are served straight from
 * there - no expiry, no per-request signing. Otherwise falls back to a
 * 7-day presigned GET URL, which needs no public bucket access at all
 * (Meta only ever needs to fetch the media shortly after the message is
 * queued, so 7 days is comfortably more than enough headroom).
 */
export async function r2ObjectUrl(key: string): Promise<string> {
  const publicBase = process.env.CLOUDFLARE_R2_PUBLIC_URL;
  if (publicBase) {
    return `${publicBase.replace(/\/$/, "")}/${key}`;
  }

  const client = getR2Client();
  const command = new GetObjectCommand({ Bucket: getR2Bucket(), Key: key });
  return getSignedUrl(client, command, { expiresIn: 60 * 60 * 24 * 7 });
}
