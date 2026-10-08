# Security

## Reporting a vulnerability

Please email **andrewjeanettebusiness@gmail.com** rather than opening a public issue. I'll reply within a few days.

## How the project handles secrets

This is a static, client-side app in a public repository, so **no secret ever lives in the repo or the build**.

- **Google Maps API key.** A browser key is always visible to the browser by design. It is protected by
  restrictions in Google Cloud Console, not by hiding it. Before deploying a key, do all of these:
  - restrict it to your **HTTP referrers** (for example `https://andrewjeanette.com/*`),
  - restrict it to the **APIs** the app uses: Maps JavaScript, Places API (New), Routes, Geocoding, Map Tiles,
  - set **daily quotas** and a **budget alert** so abuse can't run up a bill.
- The key reaches the app at runtime in one of three ways, none of them committed to git:
  1. `config.json` generated at deploy time from an environment variable (how andrewjeanette.com does it),
  2. `.env.local` for local development (git-ignored, see `.env.example`),
  3. a key a user pastes into Settings, which stays in their own browser's localStorage.
- `npm run publish:site` refuses to run if a key is set in the build environment, and never copies `config.json`.

## Hardening in the app

- **Content-Security-Policy** on production builds, with an explicit allowlist of every origin
  (see `vite.config.ts`). `'unsafe-eval'` and `blob:` are present only because Google's Maps JavaScript API and
  MapLibre's workers require them.
- **No `innerHTML`.** Place names, addresses and route instructions come from third-party APIs, so the UI is
  built with `textContent` only. ESLint fails the build if `innerHTML`/`outerHTML` appear.
- **Validated input.** Share-link coordinates, saved settings and controller profiles are parsed against strict
  shapes and ranges; anything else is discarded.
- **Referrer policy** `strict-origin-when-cross-origin` and no cookies, accounts or server-side state.
- Street View panorama IDs are never stored long-term, per Google's terms.
