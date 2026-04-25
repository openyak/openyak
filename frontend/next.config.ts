import type { NextConfig } from "next";
import path from "path";

const isDesktopBuild = process.env.DESKTOP_BUILD === "true";
const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const devSessionToken = process.env.NEXT_PUBLIC_OPENYAK_DEV_SESSION_TOKEN;

function backendApiDestination(): string {
  const base = `${backendUrl}/api/:path*`;
  if (!devSessionToken) return base;
  return `${base}?token=${encodeURIComponent(devSessionToken)}`;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },

  // Static export for Electron desktop builds
  ...(isDesktopBuild && {
    output: "export",
    images: { unoptimized: true },
  }),

  // API proxy rewrites (only needed in web mode, not in static export)
  ...(!isDesktopBuild && {
    async rewrites() {
      return [
        {
          source: "/api/:path*",
          destination: backendApiDestination(),
        },
        {
          source: "/health",
          destination: `${backendUrl}/health`,
        },
      ];
    },
  }),
};

export default nextConfig;
