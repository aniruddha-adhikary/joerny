import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../shared/layer.js";
import type { LayerStore } from "./store.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

export interface ServerHandle {
  port: number;
  close: () => Promise<void>;
}

export interface StartOptions {
  store: LayerStore;
  session: string;
  key: string;
  publicDir: string;
  port: number;
  host?: string;
}

/**
 * Serves the static frontend and a WebSocket that streams layer diffs. Both the
 * page and the socket require the per-session `?key=` (superpowers-style) so a
 * random localhost process can't read the analysis.
 */
export function startServer(opts: StartOptions): Promise<ServerHandle> {
  const { store, session, key, publicDir, host = "127.0.0.1" } = opts;

  const authorized = (url: URL): boolean => url.searchParams.get("key") === key;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!authorized(url)) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("joerny: missing or invalid ?key=");
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    // Prevent path traversal.
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(publicDir, safe);
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!authorized(url)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    for (const client of wss.clients) send(client, msg);
  };

  wss.on("connection", (ws) => {
    send(ws, { type: "hello", session, layers: store.all() });
    ws.on("message", (data) => {
      // Feedback hook — stubbed for the watch-only MVP: log and move on.
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        if (msg.type === "select") {
          console.log(`[joerny] select layer=${msg.layerId} node=${msg.nodeId ?? "-"} (feedback loop not enabled)`);
        }
      } catch {
        /* ignore malformed client messages */
      }
    });
  });

  store.on("upserted", (layer) => broadcast({ type: "layer-upserted", layer }));
  store.on("removed", (id) => broadcast({ type: "layer-removed", id }));

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port, host, () => {
      const addr = httpServer.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            httpServer.close(() => r());
          }),
      });
    });
  });
}
