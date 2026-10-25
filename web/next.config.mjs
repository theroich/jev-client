import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.resolve(appDir, ".."),
  serverExternalPackages: ["better-sqlite3"],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
