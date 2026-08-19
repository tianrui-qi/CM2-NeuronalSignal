# CM2-NeuronalSignal Sites Deployment Instructions

## Scope

This file applies to `site/**`. Read the repository `AGENTS.md` first; it owns
the scientific cache and Default Profile contracts. This directory is a
deployment adapter for the existing Flask-served viewer, not a second viewer.
The deployed HTML and Sites display title are `CM2-NeuronalSignal`; the GitHub
repository name remains `CM2-NeuronalSignal`.

## Deployment Boundary

- Preserve the browser-visible routes and payloads of ordinary
  `python -m script.serve` with `edit_default=false`.
- The deployed `/api/ui-state` is read-only browser mode. User changes stay in
  origin-scoped `localStorage`; never expose Default Profile writes publicly.
- Source UI files remain under `web/**`, the Default Profile remains under
  `data/serve/**`, and the canonical scientific cache remains under
  `data/cache/**`. Do not edit generated copies under `site/public` or
  `site/dist`.
- `cache-deployment.json` pins every deployment input by byte length and
  SHA-256. Refresh it intentionally after a validated cache or Plotly change.
- Worker static assets have a per-file size limit. Deployment-only chunks are
  reassembled at the original canonical `/cache/temporal/*.float32` URLs; the
  local cache layout and browser cache contract must not change.
- Cache bytes are stored only under hash-scoped, noncanonical deployment
  transport paths. Every canonical `/cache/*` request must enter the Worker,
  which restores the exact content type, byte length, and `no-store` policy.
- Transport paths are an internal routing convention, not an access-control
  boundary; they contain the same read-only bytes as their canonical routes.
- Static UI and hash-scoped transport objects use the Sites asset layer
  directly. Do not force the Worker ahead of matching static assets; keeping
  canonical cache URLs out of the asset tree is the routing boundary.
- `.openai/hosting.json` stores only the Sites project ID and logical resource
  bindings. Never put credentials, runtime secrets, or physical bucket names
  in it.

## Build And Verification

Use the bundled Node runtime when system Node is unavailable. Activate the
`cm2-neuronalsignal` conda environment before building only when the vendored
Plotly bundle is absent. A deployment change is ready only after:

1. the Python cache and Default Profile validators pass;
2. `pnpm run build` succeeds;
3. `pnpm run smoke -- <local-worker-url>` verifies the browser-mode profile,
   cache allowlist, and every canonical cache length, content type, and SHA-256;
4. the Sites packaging helper accepts `dist/server/index.js`, all client
   assets, and `.openai/hosting.json`.

Do not commit `node_modules`, generated `public`, `dist`, Wrangler state, or a
deployment archive.
