import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "systemvitals.nihey.org" }],
        destination: "https://systemvitals.link/:path*",
        permanent: true,
      },
    ];
  },
  // The OG/Twitter card routes read the vendored Space Grotesk TTFs at runtime.
  // Standalone tracing cannot see a runtime `readFile`, so the directory has to
  // be pulled in explicitly or the cards 500 in production.
  outputFileTracingIncludes: {
    "/opengraph-image": ["./assets/fonts/**"],
    "/twitter-image": ["./assets/fonts/**"],
    "/status/[slug]/opengraph-image": ["./assets/fonts/**"],
    "/status/[slug]/twitter-image": ["./assets/fonts/**"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // Last matching header wins. Keep this after the global policy so the
        // bearer-bearing handoff URL cannot be sent as a referrer.
        source: "/login",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        // Verification tokens are bearer credentials and must never leave
        // this public page through a referrer header.
        source: "/verify-email",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
      {
        // Keep the destination protected even after the login handoff.
        source: "/channels/telegram/connect",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
