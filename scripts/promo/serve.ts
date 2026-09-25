/**
 * npm run promo — starts the development server and points at the film (/promo).
 * Pass --port <n> to choose the port (default 3000).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT, parseArgs } from "./lib";

const port = parseArgs(process.argv.slice(2)).number("port", 3000);
const child = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "--port", String(port)], { cwd: ROOT, stdio: "inherit" });
const url = `http://localhost:${port}/promo`;
const announce = async () => {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) { console.log(`\n  ▶ The SCF Presence film: ${url}\n    Space play/pause · F fullscreen · M mute · C subtitles · Esc controls\n`); return; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
};
void announce();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", code => process.exit(code ?? 0));
