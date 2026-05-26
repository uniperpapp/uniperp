/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // wagmi / connectkit pull in optional peer deps (pino-pretty, lokijs, encoding)
  // that aren't installed. Without a fallback, webpack tries to resolve them.
  // The previous version of this config used `config.externals.push(...)`, which
  // hung Next.js dev startup forever on this Windows environment — the documented
  // Next.js pattern is `resolve.fallback: { [mod]: false }`.
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      'pino-pretty': false,
      lokijs: false,
      encoding: false,
    };
    return config;
  },
};

module.exports = nextConfig;
