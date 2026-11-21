// Wisp v1 server core for Cloudflare Workers / Pages Functions.
// Pure protocol + relay logic; the socket opener is injected so it can be tested
// outside the Workers runtime (see wisp.test.ts).
//
// Wisp frame: [type u8][stream id u32 LE][payload]. The page's epoxy client runs
// TLS itself, so this only pipes raw TCP bytes and never sees Roblox sessions.

export const ALLOWED_HOSTS = /(^|\.)(roblox\.com|rbxcdn\.com|robloxlabs\.com)$/i;
export const ALLOWED_PORT = 443;

const CONNECT = 0x01;
const DATA = 0x02;
const CONTINUE = 0x03;
const CLOSE = 0x04;

const REASON_VOLUNTARY = 0x02;
const REASON_NETWORK_ERROR = 0x03;
const REASON_INVALID = 0x41;
const REASON_UNREACHABLE = 0x42;
const REASON_BLOCKED = 0x48;

const BUFFER_PACKETS = 128; // credits the client gets per stream
const ACK_EVERY = 32; // refresh credits every N packets written upstream
const MAX_STREAMS = 64;
const CHUNK = 16 * 1024;

export type SocketLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void> | void;
};
export type Connect = (address: { hostname: string; port: number }) => SocketLike;
export type WsLike = {
  send(data: ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: any) => void): void;
};

export function frame(type: number, streamId: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, streamId, true);
  out.set(payload, 5);
  return out;
}

export function continueFrame(streamId: number, remaining: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, remaining, true);
  return frame(CONTINUE, streamId, payload);
}

export function closeFrame(streamId: number, reason: number): Uint8Array {
  return frame(CLOSE, streamId, Uint8Array.of(reason));
}

export function isAllowedTarget(hostname: string, port: number): boolean {
  return port === ALLOWED_PORT && ALLOWED_HOSTS.test(hostname);
}

type Stream = { writer: WritableStreamDefaultWriter<Uint8Array>; socket: SocketLike; received: number; written: number };

export function serveWisp(ws: WsLike, connect: Connect): void {
  const streams = new Map<number, Stream>();
  const send = (data: Uint8Array) => {
    try {
      ws.send(data);
    } catch {}
  };

  const end = (id: number, reason: number | null) => {
    const stream = streams.get(id);
    if (!stream) return;
    streams.delete(id);
    if (reason !== null) send(closeFrame(id, reason));
    stream.writer.close().catch(() => {});
    Promise.resolve(stream.socket.close()).catch(() => {});
  };

  const open = (id: number, payload: Uint8Array) => {
    if (payload.length < 3 || streams.has(id) || streams.size >= MAX_STREAMS) return send(closeFrame(id, REASON_INVALID));
    const kind = payload[0];
    const port = new DataView(payload.buffer, payload.byteOffset).getUint16(1, true);
    const hostname = new TextDecoder().decode(payload.subarray(3));
    if (kind !== 1 || !isAllowedTarget(hostname, port)) return send(closeFrame(id, REASON_BLOCKED));

    let socket: SocketLike;
    try {
      socket = connect({ hostname, port });
    } catch {
      return send(closeFrame(id, REASON_UNREACHABLE));
    }
    const stream: Stream = { writer: socket.writable.getWriter(), socket, received: 0, written: 0 };
    streams.set(id, stream);
    send(continueFrame(id, BUFFER_PACKETS));

    socket.opened.catch(() => end(id, REASON_UNREACHABLE));
    (async () => {
      const reader = socket.readable.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let i = 0; i < value.length; i += CHUNK) send(frame(DATA, id, value.subarray(i, i + CHUNK)));
        }
        end(id, REASON_VOLUNTARY);
      } catch {
        end(id, REASON_NETWORK_ERROR);
      }
    })();
  };

  const data = (id: number, payload: Uint8Array) => {
    const stream = streams.get(id);
    if (!stream) return;
    stream.received++;
    stream.writer
      .write(payload)
      .then(() => {
        stream.written++;
        if (stream.written % ACK_EVERY === 0 && streams.get(id) === stream) {
          send(continueFrame(id, Math.max(1, BUFFER_PACKETS - (stream.received - stream.written))));
        }
      })
      .catch(() => end(id, REASON_NETWORK_ERROR));
  };

  ws.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(event.data);
    if (bytes.length < 5) return;
    const id = new DataView(event.data).getUint32(1, true);
    const payload = bytes.subarray(5);
    if (bytes[0] === CONNECT) open(id, payload);
    else if (bytes[0] === DATA) data(id, payload);
    else if (bytes[0] === CLOSE) end(id, null);
  });
  const shutdown = () => {
    for (const id of [...streams.keys()]) end(id, null);
  };
  ws.addEventListener("close", shutdown);
  ws.addEventListener("error", shutdown);

  // Stream 0 CONTINUE tells a Wisp v1 client the server is ready.
  send(continueFrame(0, BUFFER_PACKETS));
}
