import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";

/** Shared helpers for the promo production scripts (run through npm, from the repository root). */
export const ROOT = process.cwd();
if (!existsSync(path.join(ROOT, "src/promo/script.ts"))) {
  console.error("Run the promo scripts from the repository root (npm run promo:…).");
  process.exit(1);
}

export function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    const next = argv[i + 1];
    if (inline !== undefined) flags.set(key, inline);
    else if (next !== undefined && !next.startsWith("--")) { flags.set(key, next); i++; }
    else flags.set(key, true);
  }
  return {
    has: (key: string) => flags.has(key),
    string: (key: string, fallback?: string) => { const value = flags.get(key); return typeof value === "string" ? value : fallback; },
    number: (key: string, fallback: number) => { const value = Number(flags.get(key)); return Number.isFinite(value) ? value : fallback; },
  };
}

export function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** ffmpeg: $FFMPEG_PATH, then ffmpeg on PATH, then the ffmpeg-static package. */
export function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, "ffmpeg"];
  try { candidates.push(createRequire(path.join(ROOT, "package.json"))("ffmpeg-static") as string); } catch { /* optional dependency not installed */ }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const probe = spawnSync(candidate, ["-hide_banner", "-version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export function ffmpegEncoders(ffmpeg: string): Set<string> {
  const out = spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout ?? "";
  return new Set(out.split("\n").map(line => line.trim().split(/\s+/)[1]).filter(Boolean));
}

export async function freePort(preferred: number): Promise<number> {
  const attempt = (port: number) => new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { const { port: bound } = server.address() as { port: number }; server.close(() => resolve(bound)); });
  });
  try { return await attempt(preferred); } catch { return attempt(0); }
}

/** Runs a command to completion with inherited output. */
export function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed`);
}

/** Starts `next start` on a port and waits until /promo answers. */
export async function startServer(port: number): Promise<{ url: string; stop(): void }> {
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "production" },
  });
  let log = "";
  child.stdout?.on("data", chunk => { log += chunk; });
  child.stderr?.on("data", chunk => { log += chunk; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`next start exited:\n${log}`);
    try { if ((await fetch(`${url}/promo`)).ok) return { url, stop: () => child.kill("SIGTERM") }; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  child.kill("SIGTERM");
  fail(`the server did not start:\n${log}`);
}

/** Reads KEY=value pairs from .env.local / .env (never printed). */
export function readEnvFile(name: string): string | undefined {
  for (const file of [".env.local", ".env"]) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match?.[1] === name) return match[2].replace(/^(['"])(.*)\1$/, "$2") || undefined;
    }
  }
  return undefined;
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
