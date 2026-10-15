export interface Env {
  PHOTOS: R2Bucket;
  MEDIA_TOKEN: string;
}

// Private food-photo store. Only the Vercel app (holding MEDIA_TOKEN) talks to it;
// the Mini App gets photos through Vercel because workers.dev needs a VPN in Russia.
const KEY_PATTERN = /^food\/[0-9a-f-]{36}\.webp$/;
const MAX_BYTES = 2 * 1024 * 1024;

const worker = {
  async fetch(request: Request, env: Env) {
    if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!KEY_PATTERN.test(key)) return new Response("bad key", { status: 400 });

    if (request.method === "PUT") {
      const body = await request.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_BYTES) {
        return new Response("bad size", { status: 413 });
      }
      await env.PHOTOS.put(key, body, {
        httpMetadata: { contentType: request.headers.get("content-type") ?? "image/webp" },
      });
      return Response.json({ ok: true, key, bytes: body.byteLength });
    }
    if (request.method === "GET") {
      const object = await env.PHOTOS.get(key);
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType ?? "image/webp",
          "content-length": String(object.size),
        },
      });
    }
    if (request.method === "DELETE") {
      await env.PHOTOS.delete(key);
      return Response.json({ ok: true });
    }
    return new Response("method not allowed", { status: 405 });
  },
};

export default worker;

function authorized(request: Request, env: Env) {
  if (!env.MEDIA_TOKEN) return false;
  const given = new TextEncoder().encode(request.headers.get("authorization") ?? "");
  const expected = new TextEncoder().encode(`Bearer ${env.MEDIA_TOKEN}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}
