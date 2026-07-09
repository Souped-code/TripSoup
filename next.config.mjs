// Hotfix (2026-07-10): Vercel serves `public/` assets with a default
// `Cache-Control: public, max-age=0, must-revalidate` — the browser
// revalidates on every visit even though the CDN edge-caches. The reveal map
// textures are large images fetched on every trip load; long-lived immutable
// caching means a returning visitor never re-fetches them.
//
// `immutable` trades in staleness protection: if a texture is ever re-exported
// under the SAME filename, visitors with a cached copy keep the stale one for
// up to a year. Ship any future texture change under a new filename (or add a
// version segment to the path) rather than overwriting land.webp in place.
/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: "/map/assets/tex/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
