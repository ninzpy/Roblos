// Builds dist/ for Cloudflare Pages:  node scripts/build-pages.mjs [version-xxxxxxxxxxxxxxxx]
//   dist/blox/{index.html,host.js,host.css,sw.js,epoxy.mjs}   host page + epoxy client
//   dist/blox/engine/{version.json,PinnedFlags.json}          the only engine files shipped
//   dist/_headers, _redirects, _routes.json                   isolation headers, / redirect, function routing
// The engine itself (~255 MB, wasm over Pages' 25 MiB limit) is streamed from
// Roblox's CDN by functions/blox/engine/[[path]].ts; /wisp/ is functions/wisp/.
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const BINARY_TYPE = "WebClientApp";
const VERSION_RE = /^version-[0-9a-f]{16}$/;
const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

async function epoxyBundle() {
  const candidates = [];
  try {
    candidates.push(fileURLToPath(import.meta.resolve("@mercuryworkshop/epoxy-transport")));
  } catch {}
  candidates.push(join(ROOT, "node_modules/@mercuryworkshop/epoxy-transport/dist/index.mjs"));
  for (const path of candidates) if (await stat(path).then(() => true, () => false)) return path;
  throw new Error("@mercuryworkshop/epoxy-transport is not installed; run npm install (or bun install) first");
}

async function main() {
  const pinned = process.argv[2] ?? process.env.WEBBLOX_ENGINE_VERSION;
  if (pinned && !VERSION_RE.test(pinned)) throw new Error(`"${pinned}" is not a version-<16 hex> upload id`);
  const live = pinned ? null : await getJson(`https://clientsettings.roblox.com/v2/client-version/${BINARY_TYPE}`);
  const upload = pinned ?? live.clientVersionUpload;
  if (!VERSION_RE.test(upload ?? "")) throw new Error(`unexpected client-version response: ${JSON.stringify(live)}`);
  console.log(`[pages] engine ${upload}${live ? ` (${live.version})` : " (pinned)"}`);

  await rm(DIST, { recursive: true, force: true });
  await mkdir(join(DIST, "blox", "engine"), { recursive: true });
  await cp(join(ROOT, "webblox"), join(DIST, "blox"), { recursive: true });
  await cp(await epoxyBundle(), join(DIST, "blox", "epoxy.mjs"));

  // Same shapes fetch-webblox.mjs writes: flags pinned to the engine they belong to.
  const flags = await getJson(`https://clientsettingscdn.roblox.com/v2/settings/application/${BINARY_TYPE}`);
  const pinnedAt = new Date().toISOString();
  await writeFile(join(DIST, "blox", "engine", "PinnedFlags.json"),
    JSON.stringify({ engine: upload, pinnedAt, applicationSettings: flags.applicationSettings }));
  await writeFile(join(DIST, "blox", "engine", "version.json"),
    JSON.stringify({ clientVersionUpload: upload, source: `https://setup.rbxcdn.com/webclient/${upload}-RobloxWebClient`, fetchedAt: pinnedAt }));

  const isolation = [
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Embedder-Policy: require-corp",
    "  Cross-Origin-Resource-Policy: same-origin",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  X-Content-Type-Options: nosniff",
    "  Cache-Control: no-cache",
  ].join("\n");
  await writeFile(join(DIST, "_headers"), `/blox/*\n${isolation}\n`);
  await writeFile(join(DIST, "_redirects"), "/ /blox/ 308\n");
  // Functions only run for the engine proxy and Wisp; the small static engine
  // files and the host page are served straight from the asset store.
  await writeFile(join(DIST, "_routes.json"), JSON.stringify({
    version: 1,
    include: ["/blox/engine/*", "/wisp", "/wisp/*"],
    exclude: ["/blox/engine/version.json", "/blox/engine/PinnedFlags.json"],
  }, null, 2));
  console.log(`[pages] done: ${DIST}`);
}

main().catch((err) => {
  console.error(`[pages] ${err.message}`);
  process.exit(1);
});
