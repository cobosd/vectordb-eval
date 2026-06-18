# vectordb-eval dashboard

A Next.js (App Router) dashboard that visualizes the latency eval results. It
reads the eval markdown from the repo root at **build time** and renders fully
static pages — no runtime database or filesystem access.

- `/` — interactive dashboard (charts + sortable/filterable data table), with a
  picker to switch between eval runs.
- `/notes` — `NOTES.md` rendered as a page.

## Data source

The pages read these files from the **repo root** (one level above this app)
when the site is built:

- `evals/*.md` — one file per eval run (newest first)
- `NOTES.md` — service capabilities / limitations

Parsing lives in [`lib/eval-data.ts`](lib/eval-data.ts); the build-time loader is
[`lib/load-evals.ts`](lib/load-evals.ts). Because the data is baked in at build
time, **adding or editing an eval requires a redeploy** (or a local rebuild).

## Local development

```bash
cd src/dashboard
bun install
bun dev          # http://localhost:3000
```

Build / preview the production output:

```bash
bun run build
bun run start
```

## Deploy to Vercel

This app is a sub-directory of a larger repo (the eval harness lives at the
root), and it reads eval files from that root at build time.

1. Import the repo in Vercel.
2. Set **Root Directory** to `src/dashboard` (Project → Settings → Build &
   Deployment → Root Directory).
3. Enable **"Include files outside of the Root Directory in the Build Step"**
   (the checkbox next to Root Directory). This keeps `../../evals` and
   `../../NOTES.md` available during the build.
4. Framework preset is auto-detected as **Next.js**. Vercel detects `bun.lock`
   and installs with Bun. No other configuration needed.

Pages are statically prerendered, so the deployment is served from the edge with
no serverless cold starts.
