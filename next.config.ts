import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile Babylon.js packages for proper chunk loading
  transpilePackages: ["@babylonjs/serializers"],

  // Empty turbopack config to silence warning
  turbopack: {},
};

export default nextConfig;
