import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    // Never ship with type errors. `pnpm typecheck` is also enforced in CI.
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
  experimental: {
    // Server Actions receive multi-megabyte PDFs from the upload panel.
    serverActions: {
      bodySizeLimit: '25mb',
    },
  },
  // `unpdf` and the Langfuse SDK ship Node-only code paths that must not be
  // bundled into the Edge runtime.
  serverExternalPackages: ['unpdf', 'langfuse'],
};

export default nextConfig;
