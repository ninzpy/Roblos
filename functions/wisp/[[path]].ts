// /wisp/: WebSocket Wisp server on Cloudflare, limited to Roblox hosts on 443.
// Replaces the Wisp half of server.ts, which needs Node and cannot run on Pages.
import { connect } from "cloudflare:sockets";
import { serveWisp } from "../_lib/wisp.ts";

export const onRequest = async ({ request }: { request: Request }): Promise<Response> => {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  serveWisp(server as never, ((address: { hostname: string; port: number }) => connect(address)) as never);
  return new Response(null, { status: 101, webSocket: client });
};
