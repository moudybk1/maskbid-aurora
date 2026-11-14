import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@maskbid/protocol", "@maskbid/contracts"],
  reactStrictMode: true,
  devIndicators: false, // the dev-only "N" bubble would sit on every screen of a recorded demo
};
export default config;
