# Deployment

The TCI Sim PWA itself is **build-step-free static files** — Vercel serves the
repo root as-is, and any static host works. The only piece that needs
configuration is the **cloud sync** backend (`api/sync.js`), which runs
as a Vercel serverless function backed by Upstash Redis. This document covers
its environment variables and setup.

> Sync is **optional**. Without it configured, the app runs normally; the
> cloud pull/push buttons simply report "Sync unavailable". See
> `SCRATCHPAD-SYNC-SPEC.md` for the sender (scratchpad) side of the contract.

## Payload kinds

One function serves three payload kinds, all keyed by the shared 6-character
pairing code and dispatched by a `kind` parameter (`?kind=` on GET, `body.kind`
on POST; **absent = `patient`**, which keeps the deployed scratchpad app's
contract unchanged):

| Kind | Purpose | Redis key | TTL | Size cap |
|---|---|---|---|---|
| `patient` (default) | Demographics from the scratchpad app | `tcisync:{code}` | 30 min | 1 KB |
| `case` | TCIsim saved-case blob, for moving a case to another device | `tcisync:{code}:case` | 24 h | 64 KB |
| `template` | TCIsim starting-dose template | `tcisync:{code}:template` | 30 days | 4 KB |

Case and template payloads get light sanity checks server-side (shape + size);
full validation happens in the TCIsim client on pull. All kinds share the same
env vars, CORS allow-list, and unauthenticated last-writer-wins model.

## Environment variables

`api/sync.js` reads three variables:

| Variable | Purpose | Source |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | REST endpoint of the Redis store (e.g. `https://us1-xxxx.upstash.io`) | Upstash — auto-injected by the Vercel integration |
| `UPSTASH_REDIS_REST_TOKEN` | Bearer token used to read/write that store | Upstash — same |

> The function also accepts the Vercel KV / Marketplace integration names
> `KV_REST_API_URL` / `KV_REST_API_TOKEN` as a fallback, since the integration
> sometimes injects those instead. Either pair works; you do not need both.
| `SYNC_ALLOWED_ORIGINS` | Comma-separated CORS allow-list of origins permitted to call `/api/sync`. **Must include the scratchpad app's origin.** | Set manually |

The first two are credentials for the cloud store; the third is the security
gate deciding which websites may push/pull. The function returns HTTP 500
`{"error":"kv-not-configured"}` if the Upstash vars are missing.

## Step 1 — Provision the Redis store (gets the first two vars)

The easy path auto-creates `UPSTASH_REDIS_REST_URL` and
`UPSTASH_REDIS_REST_TOKEN`:

1. Vercel dashboard → TCIsim project → **Storage** → **Create Database** →
   **Upstash for Redis** (Marketplace).
2. Name it, pick a region near you, create.
3. **Connect it to the TCIsim project** when prompted. Vercel injects the URL
   and token into the project environment automatically.

*Manual alternative:* create the database at upstash.com, copy the **REST URL**
and **REST Token** from its dashboard, and add them in Step 2.

## Step 2 — Set `SYNC_ALLOWED_ORIGINS`

Vercel dashboard → TCIsim project → **Settings → Environment Variables**:

- **Key:** `SYNC_ALLOWED_ORIGINS`
- **Value:** the scratchpad's origin (scheme + host, **no trailing slash, no
  path**), comma-separated if listing more than one. Example:
  ```
  https://my-scratchpad.vercel.app,https://tcisim.vercel.app
  ```
- **Environments:** tick **Production** (and **Preview** if you test on preview
  deploys — each environment has independent values).

**The value must match the browser's `Origin` header exactly.**
`https://app.vercel.app` ≠ `https://www.app.vercel.app` ≠ a custom domain. A
mismatch here is the most common cause of the scratchpad push silently failing
(blocked by CORS preflight).

**Redeploy** after adding or changing any variable — Vercel does not apply env
changes to an already-running deployment.

## Step 3 (optional) — Local end-to-end testing with `vercel dev`

`python3 -m http.server` does **not** execute `/api`, so the Pull button shows
"Sync unavailable" under the plain static server (expected). To exercise the
function locally:

```bash
npm i
vercel link                  # one-time: link this folder to the Vercel project
vercel env pull .env.local   # download the vars set above into a gitignored file
vercel dev                   # serves the static site AND /api on localhost
```

`vercel env pull` writes the three variables into `.env.local`, which
`vercel dev` loads automatically. **Do not commit `.env.local`** — it contains
the Upstash token (ensure `.gitignore` covers `.env*`).

## Sanity check

After deploying with the vars set:

```bash
# write
curl -X POST https://<tcisim-host>/api/sync \
  -H 'Content-Type: application/json' \
  -d '{"code":"ABC234","patient":{"age":45,"sex":"male","heightCm":180,"weightKg":80}}'
# → {"ok":true,"updatedAt":...}

# read back
curl 'https://<tcisim-host>/api/sync?code=ABC234'
# → {"found":true,"patient":{...}}
```

- `{"error":"kv-not-configured"}` (500) → the two Upstash vars aren't set on
  that deployment.
- Browser push from the scratchpad fails but curl works → `SYNC_ALLOWED_ORIGINS`
  doesn't match the scratchpad's origin.

## Notes

- **TTL:** per-kind, refreshed on each POST — see the table above (`KINDS` in
  `api/sync.js`).
- **Validation / privacy:** the patient kind validates ranges, caps the body at
  1 KB, and stores only age/sex/height/weight + a server-set `updatedAt`. Case
  and template kinds carry TCIsim's own JSON (still de-identified — patient
  demographics plus dosing events / dose preferences). The endpoint is
  unauthenticated (the pairing code is the only secret) and last-writer-wins —
  de-identified / training data only.
- **Runtime:** the Node version is **not** pinned in the repo — it follows the
  Vercel project's *Settings → Build and Deployment → Node.js Version*, so
  upgrades (e.g. when a major reaches end-of-life) are a dashboard change, not a
  commit. Do not add `engines.node` back to `package.json`: it overrides the
  dashboard and silently opts the project out of Vercel's managed upgrades.
  Vercel auto-detects `api/*.js` as Node serverless functions, so no
  `vercel.json` is needed either — and note that an early `vercel.json` using
  `functions.runtime: "nodejs20.x"` broke the build, since that key is for
  community runtimes needing `name@version`. `package.json` exists only to
  declare `@upstash/redis`; it intentionally omits `"type": "module"` so the
  CommonJS test runner keeps working, which is why `api/sync.js` is written in
  CommonJS.
