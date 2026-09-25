import "server-only";
import { searchWebImage } from "@/server/imageSearch";

// Optional keyed image search. Reads BRAVE_SEARCH_API_KEY at request time; without it, answers 503.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await searchWebImage(request, process.env);
  if (result.body instanceof Uint8Array) {
    return new Response(result.body as BodyInit, {
      status: result.status,
      headers: {
        "Content-Type": result.mime ?? "application/octet-stream", "Cache-Control": "no-store",
        // Image bytes only: never rendered as a document, never scripted.
        "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  }
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
