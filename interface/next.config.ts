import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the dev server is also reached as 127.0.0.1 (the Supabase site URL and some links use it);
  // without this Next blocks its HMR socket and the page never hydrates
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
