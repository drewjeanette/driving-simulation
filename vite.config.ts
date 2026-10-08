import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Content-Security-Policy for production builds. Every third-party origin the
 * app talks to is listed explicitly. Google's Maps JavaScript API documents
 * 'unsafe-eval' and blob: workers as requirements in its CSP guide, and it
 * injects inline styles; MapLibre also runs its tile workers from blob: URLs.
 * (Dev builds skip the CSP because Vite's HMR client injects inline code.)
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' blob: https://maps.googleapis.com https://maps.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.ggpht.com https://*.googleusercontent.com https://tiles.openfreemap.org https://*.mapillary.com https://*.fbcdn.net",
  "connect-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://router.project-osrm.org https://photon.komoot.io https://tiles.openfreemap.org https://graph.mapillary.com https://*.mapillary.com https://*.fbcdn.net https://overpass-api.de",
  "worker-src 'self' blob:",
  'child-src blob:',
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--%CSP%-->',
        `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

// BASE_PATH lets the same build be served from a sub-path, e.g. /drive/ on
// andrewjeanette.com. Defaults to relative paths so dist/ works anywhere.
export default defineConfig({
  base: process.env.BASE_PATH ?? './',
  plugins: [csp()],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, host: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
