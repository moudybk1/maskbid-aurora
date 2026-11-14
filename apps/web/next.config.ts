import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@maskbid/protocol", "@maskbid/contracts"],
  reactStrictMode: true,
  devIndicators: false, // the dev-only "N" bubble would sit on every screen of a recorded demo
  distDir: process.env.NEXT_DIST_DIR || ".next", // lets a second dev server run beside another one from the same checkout
};
export default config;
