import "server-only";
import { createRealtimeToken } from "@/server/realtimeToken";

// Reads OPENAI_API_KEY at request time on the Node.js runtime. POST handlers are never cached.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const { status, body } = await createRealtimeToken(request, process.env);
  if (status !== 200) console.warn(`[realtime/token] ${status} ${String(body.error)}${body.detail ? `: ${String(body.detail)}` : ""}`);
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
