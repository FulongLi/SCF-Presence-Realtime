import type { NextConfig } from "next";

// A server deployment (not a static export): /api/realtime/token needs OPENAI_API_KEY at request time.
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        // Only this origin may use the microphone; nothing needs the camera or geolocation.
        { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }];
  },
};
export default config;
