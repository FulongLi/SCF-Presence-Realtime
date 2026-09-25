import "server-only";
import { createLiveSession } from "@/server/liveSession";

// Reads OPENAI_API_KEY at request time on the Node.js runtime. POST handlers are never cached.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const { status, body } = await createLiveSession(request, process.env);
  if (status !== 200) console.warn(`[live/session] ${status} ${String(body.error)}${body.detail ? `: ${String(body.detail)}` : ""}`);
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
