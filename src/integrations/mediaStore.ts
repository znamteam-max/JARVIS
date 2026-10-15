import { requireEnv } from "@/lib/env";

const TIMEOUT_MS = 15_000;

// The jarvis-media Cloudflare worker (cloudflare-media-worker/) in front of the R2 bucket.
async function mediaRequest(key: string, init: RequestInit) {
  const base = requireEnv("MEDIA_WORKER_URL").replace(/\/?$/, "/");
  return fetch(new URL(key, base), {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${requireEnv("MEDIA_WORKER_TOKEN")}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export async function putMedia(key: string, bytes: Buffer, contentType: string) {
  const response = await mediaRequest(key, {
    method: "PUT",
    body: new Uint8Array(bytes),
    headers: { "content-type": contentType },
  });
  if (!response.ok) throw new Error(`Media upload failed: ${response.status}`);
}

export async function getMedia(key: string) {
  const response = await mediaRequest(key, { method: "GET" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Media read failed: ${response.status}`);
  return {
    bytes: await response.arrayBuffer(),
    contentType: response.headers.get("content-type") ?? "image/webp",
  };
}

export async function deleteMedia(key: string) {
  const response = await mediaRequest(key, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Media delete failed: ${response.status}`);
  }
}
