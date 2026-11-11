import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@maskbid/protocol", "@maskbid/contracts"],
  reactStrictMode: true,
};
export default config;
