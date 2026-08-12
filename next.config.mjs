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
import { withSentryConfig } from "@sentry/nextjs";

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
  // E6a — src/lib/engineWorker/host.ts spawns a worker_thread by handing
  // `new Worker()` a plain runtime path string (never a `require`/`import`),
  // so Next's automatic file-tracing (which only follows require/import
  // graphs) has no way to discover that the deployed function needs
  // worker.generated.cjs on disk. This is the explicit hint that makes
  // Vercel ship it anyway. Scoped to every API route (the only place a solve
  // ever runs — see app/api/pipeline/route.ts and app/api/trips/[id]/*)
  // rather than every page, since pages never call runSolve directly.
  outputFileTracingIncludes: {
    "app/api/**/*": ["./src/lib/engineWorker/worker.generated.cjs"],
  },
};

// M0.3: error observability via Sentry. Conservative on purpose — no auth
// token is configured in this environment, so source-map upload and release
// management are explicitly turned off rather than left to fail/warn at
// build time. Runtime init (with the PII-scrub beforeSend) lives in
// instrumentation.ts / instrumentation-client.ts / sentry.server.config.ts /
// sentry.edge.config.ts.
export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  disableLogger: true,
  sourcemaps: { disable: true },
});
