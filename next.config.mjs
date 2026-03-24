/** @type {import('next').NextConfig} */
const nextConfig = {
  // Prevent Next.js from bundling native binaries — lets them resolve via
  // their real node_modules path at runtime instead of a mangled vendor-chunk.
  serverExternalPackages: ['ffmpeg-static', 'fluent-ffmpeg'],
};

export default nextConfig;
