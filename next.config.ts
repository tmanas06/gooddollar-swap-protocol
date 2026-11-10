import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow opening the dev server via 127.0.0.1 (avoids oversized localhost cookies from other apps).
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
