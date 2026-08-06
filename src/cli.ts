#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { LayerStore } from "./server/store.js";
import { watchLayers } from "./server/watcher.js";
import { startServer } from "./server/httpServer.js";
import { resolveSession, writeServerInfo } from "./server/session.js";

interface Args {
  projectDir: string;
  session: string;
  port: number;
  open: boolean;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    projectDir: process.cwd(),
    session: "current",
    port: 0, // 0 = OS-assigned unless a prior run's port is reused
    open: false,
    host: "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => argv[++i];
    switch (a) {
      case "--project-dir": args.projectDir = resolve(next()); break;
      case "--session": args.session = next(); break;
      case "--port": args.port = parseInt(next(), 10); break;
      case "--host": args.host = next(); break;
      case "--open": args.open = true; break;
      case "--no-open": args.open = false; break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`joerny — live viewer for Joern analysis layers

Usage: joerny [options]

Options:
  --project-dir <path>  Project root; layers live in <path>/.joerny/<session>/  (default: cwd)
  --session <name>      Session name                                            (default: current)
  --port <n>            Port to bind                              (default: reuse prior / OS-assigned)
  --host <addr>         Host to bind                                            (default: 127.0.0.1)
  --open                Open the browser on start
  --help                Show this help

The printed URL includes a per-session access key; the page and WebSocket
require it. Point your Joern scripts at the layers dir via JOERNY_DIR.
`);
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* opening the browser is best-effort */
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/cli.js -> ../public
  const publicDir = join(here, "..", "public");

  const info = resolveSession(args.projectDir, args.session);
  const store = new LayerStore();
  const watcher = watchLayers(info.layersDir, store);

  const port = args.port || info.preferredPort || 0;
  const handle = await startServer({
    store,
    session: info.session,
    key: info.key,
    publicDir,
    port,
    host: args.host,
  });

  const url = `http://${args.host}:${handle.port}/?key=${info.key}`;
  writeServerInfo(info, handle.port, url);

  console.log(`[joerny] session "${info.session}" — layers: ${info.layersDir}`);
  console.log(`[joerny] point your Joern scripts here:  export JOERNY_DIR="${info.layersDir}"`);
  console.log(`[joerny] open in browser:  ${url}`);
  if (args.open) openBrowser(url);

  const shutdown = async (): Promise<void> => {
    // Hard-exit fallback in case a close() hangs (open sockets, etc.).
    setTimeout(() => process.exit(0), 500).unref();
    try {
      await Promise.allSettled([watcher.close(), handle.close()]);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[joerny] fatal:", err);
  process.exit(1);
});
