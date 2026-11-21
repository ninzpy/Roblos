// /blox/engine/*: the ~255 MB Roblox engine is far over Pages' 25 MiB file
// limit, so it is streamed from Roblox's CDN (the same fallback server/blox.ts
// uses for files missing on disk), with the cross-origin isolation headers the
// engine's SharedArrayBuffer needs. PinnedFlags.json and version.json are small
// static files written by scripts/build-pages.mjs and never reach this function.
const ENGINE_PATH = /^[A-Za-z0-9_@ .()+-]+(?:\/[A-Za-z0-9_@ .()+-]+)*$/;
const MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  wasm: "application/wasm",
  png: "image/png",
  ttf: "font/ttf",
  otf: "font/otf",
};

type Env = { ASSETS: { fetch(request: Request | string): Promise<Response> } };
let source: string | undefined;

function isolated(headers: Headers): Headers {
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

const fail = (status: number, text: string) =>
  new Response(text, { status, headers: isolated(new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })) });

async function engineSource(request: Request, env: Env): Promise<string | null> {
  if (source) return source;
  const res = await env.ASSETS.fetch(new URL("/blox/engine/version.json", request.url).href);
  if (!res.ok) return null;
  const value = ((await res.json()) as { source?: unknown }).source;
  if (typeof value !== "string" || !value.startsWith("https://setup.rbxcdn.com/webclient/")) return null;
  return (source = value);
}

export const onRequest = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  if (request.method !== "GET" && request.method !== "HEAD") return fail(405, "Method not allowed");
  const url = new URL(request.url);
  let relative: string;
  try {
    relative = decodeURIComponent(url.pathname.slice("/blox/engine/".length));
  } catch {
    return fail(404, "Not found");
  }
  if (!ENGINE_PATH.test(relative) || relative.split("/").some((part) => part === "." || part === "..")) return fail(404, "Not found");
  const base = await engineSource(request, env);
  if (!base) return fail(404, "Engine version not configured");

  const upstreamHeaders = new Headers();
  for (const name of ["if-none-match", "if-modified-since", "range"]) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/${encodeURI(relative)}`, {
      method: request.method,
      headers: upstreamHeaders,
      cf: { cacheEverything: true, cacheTtl: 31536000 }, // the CDN folder is versioned, so its files never change
    } as RequestInit);
  } catch {
    return fail(502, "Roblox CDN unreachable");
  }
  if (!upstream.ok && upstream.status !== 304 && upstream.status !== 206) return fail(404, "Not found");

  const headers = isolated(new Headers());
  headers.set("content-type", MIME[relative.split(".").pop()?.toLowerCase() ?? ""] ?? upstream.headers.get("content-type") ?? "application/octet-stream");
  // Same paths across engine versions, so revalidate (etag passthrough makes this a cheap 304).
  headers.set("cache-control", "no-cache");
  for (const name of ["etag", "last-modified", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" || upstream.status === 304 ? null : upstream.body, { status: upstream.status, headers });
};
