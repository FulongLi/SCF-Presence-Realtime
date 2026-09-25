import { connection } from "next/server";
import Presence from "@/presence/Presence";
import { parseVoiceBackend } from "@/voice/backend";

// SCF_VOICE_BACKEND is read per request (not baked in at build time), so a deployment can switch backends
// with an environment change and a restart. Only the backend name reaches the browser.
export default async function Home() {
  await connection();
  return <Presence configuredBackend={parseVoiceBackend(process.env.SCF_VOICE_BACKEND)} />;
}
