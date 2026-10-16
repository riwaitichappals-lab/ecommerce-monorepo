# Environment Variables

Parsed and validated at startup by `src/app/config.ts`. Invalid or missing values stop the process with a list of problems. An empty value (`KEY=`) counts as unset. Template: [`.env.example`](../../../../.env.example) (monorepo root; shared with the admin app).

**Secrets** (never commit, never expose to a frontend): `DATABASE_URL`, `IMAGEKIT_PRIVATE_KEY`, `SUPABASE_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `REVALIDATE_SECRET`.

## Server

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | | `development` | `development` \| `test` \| `production`. Production: JSON logs, no API docs, generic 500 messages, `CORS_ORIGIN` required |
| `HOST` | | `0.0.0.0` | Bind address |
| `PORT` | | `4000` | |
| `LOG_LEVEL` | | `info` | `fatal` … `trace`, or `silent` |
| `TRUST_PROXY` | | `false` | `true` behind a proxy/LB so `request.ip` is the client (rate limiting) |

## Database

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✓ | | Postgres connection string (Supabase transaction pooler recommended for the server) |
| `DATABASE_POOL_MAX` | | `10` | Pool size per instance |
| `DATABASE_SSL` | | `true` | `false` only for local Postgres |

## Supabase

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `SUPABASE_URL` | ✓ | | `https://<ref>.supabase.co`. Token issuer and JWKS location are derived from it |
| `SUPABASE_JWT_SECRET` | | | Legacy HS256 secret (≥ 32 chars). Set only if your project signs tokens with it. When unset, HS256 tokens are rejected |
| `SUPABASE_ANON_KEY` | | | Not used by the server. Accepted so a shared `.env` validates |
| `SUPABASE_SERVICE_ROLE_KEY` | | | Not used by the server. Leave it out of the server environment where possible |

## ImageKit

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `IMAGEKIT_PUBLIC_KEY` | ✓ | | Returned to the dashboard for uploads |
| `IMAGEKIT_PRIVATE_KEY` | ✓ | | Signs uploads, authenticates verify/delete calls. **Server only** |
| `IMAGEKIT_URL_ENDPOINT` | ✓ | | e.g. `https://ik.imagekit.io/acme`. Registered image URLs must start with it |
| `IMAGEKIT_UPLOAD_FOLDER` | | `/products` | Folder suggested to the uploader |
| `IMAGEKIT_VERIFY_UPLOADS` | | `true` | Look up each registered file in ImageKit before storing it |

## HTTP

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CORS_ORIGIN` | in production | (dev: any origin) | Comma-separated allowed origins |
| `RATE_LIMIT_MAX` | | `300` | Requests per IP per window (all routes except `/health`) |
| `RATE_LIMIT_WINDOW` | | `1 minute` | e.g. `1 minute`, `30 seconds` |
| `CHECKOUT_RATE_LIMIT_MAX` | | `10` | Checkout requests per IP per minute |
| `STORE_CACHE_MAX_AGE` | | `60` | Seconds of public caching for storefront GETs; `0` → `no-cache` |
| `FRONTEND_REVALIDATE_URL` | | — | Storefront revalidation webhook, e.g. `https://shop.example.com/api/revalidate`. Called after catalogue writes. Skipped (one startup warning) unless `REVALIDATE_SECRET` is also set |
| `REVALIDATE_SECRET` | | — | Shared secret sent as `x-revalidate-secret`. Must equal the storefront's `REVALIDATE_SECRET`. Server-side only; never give it a `VITE_` copy |
| `ENABLE_API_DOCS` | | `true` outside production | Serve Swagger UI at `/docs` |

## Commerce

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `CURRENCY` | | `USD` | ISO 4217 code stored on orders and returned by the storefront |
| `SHIPPING_FLAT_RATE` | | `5` | Shipping charged below the threshold |
| `FREE_SHIPPING_THRESHOLD` | | `100` | Subtotal at or above which shipping is free |

## Background jobs

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `ASSET_CLEANUP_INTERVAL_MS` | | `300000` | Interval for retrying failed ImageKit deletions; `0` disables the in-process job |

## Test-only

| Variable | Description |
| --- | --- |
| `TEST_DATABASE_URL` | Enables `tests/integration`. Must point at a disposable database; the suite truncates all tables |

## Adding a variable

1. Add it to `envSchema` and `AppConfig` in `src/app/config.ts` (with a default if optional).
2. Add it to `.env.example` with a comment.
3. Document it here.
4. Mention it in the feature changelog if behaviour depends on it.
