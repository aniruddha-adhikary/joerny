import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SessionInfo {
  session: string;
  root: string;
  layersDir: string;
  key: string;
  /** Preferred port from a previous run of the same session, if any. */
  preferredPort?: number;
}

interface ServerInfoFile {
  session: string;
  key: string;
  port: number;
  url: string;
  pid: number;
  startedAt: string;
}

/**
 * Resolves the `.joerny/<session>/` workspace under the project dir, creating
 * the `layers/` directory. Reuses the key + port from a prior run of the same
 * session so restarts land on the same URL (superpowers behavior).
 */
export function resolveSession(projectDir: string, session: string): SessionInfo {
  const root = join(projectDir, ".joerny", session);
  const layersDir = join(root, "layers");
  mkdirSync(layersDir, { recursive: true });

  let key = randomBytes(16).toString("hex");
  let preferredPort: number | undefined;

  const infoPath = join(root, "server-info.json");
  if (existsSync(infoPath)) {
    try {
      const prev = JSON.parse(readFileSync(infoPath, "utf8")) as ServerInfoFile;
      if (typeof prev.key === "string" && prev.key.length > 0) key = prev.key;
      if (typeof prev.port === "number") preferredPort = prev.port;
    } catch {
      /* stale/corrupt info file — fall back to a fresh key/port */
    }
  }

  return { session, root, layersDir, key, preferredPort };
}

export function writeServerInfo(info: SessionInfo, port: number, url: string): void {
  const file: ServerInfoFile = {
    session: info.session,
    key: info.key,
    port,
    url,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(info.root, "server-info.json"), JSON.stringify(file, null, 2));
}
