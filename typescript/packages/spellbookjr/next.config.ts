import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "paas.saga-castor.ts.net",
      },
    ],
  },
};

export default nextConfig;
