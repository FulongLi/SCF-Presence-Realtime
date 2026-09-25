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
    }, {
      // Curated brand assets are pictures, not documents: an SVG opened directly may not run script or load anything.
      source: "/assets/:path*",
      headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox" }],
    }];
  },
};
export default config;
