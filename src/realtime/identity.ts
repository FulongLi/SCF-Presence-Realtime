const KEY = "scf-presence-realtime:installation";
const FORMAT = /^[a-z0-9-]{16,64}$/;

let fallback: string | undefined;
const random = () => typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");

/**
 * An anonymous, random per-browser installation id. It carries no personal information; the server
 * hashes it (with a server-side salt) into the OpenAI-Safety-Identifier header, so OpenAI sees a stable
 * but unlinkable identifier per installation. Clearing site data creates a new one.
 */
export function installationId(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  try {
    const existing = storage?.getItem(KEY);
    if (existing && FORMAT.test(existing)) return existing;
    const created = random();
    storage?.setItem(KEY, created);
    if (storage) return created;
  } catch { /* storage unavailable (private mode, blocked site data) */ }
  fallback ??= random();
  return fallback;
}

function safeStorage() {
  try { return window.localStorage; } catch { return null; }
}
