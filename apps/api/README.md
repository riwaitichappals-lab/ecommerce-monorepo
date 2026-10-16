# Ecommerce API Server

Node.js + TypeScript (Fastify) API that powers the ecommerce **admin dashboard** and **public storefront**. It is the only layer with access to the Supabase Postgres database and the ImageKit private key.

**Documentation: [docs/README.md](./docs/README.md)** (architecture, features and their status, API contracts, database, decisions, setup)

```bash
npm ci
cp ../../.env.example ../../.env          # fill in Supabase, ImageKit, CORS values
npm run db:migrate
npm run admin:create -- --email you@example.com --role owner
npm run dev                   # http://localhost:4000  (Swagger UI at /docs)
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Development server with reload |
| `npm run build` / `npm start` | Compile to `dist/` / run compiled server |
| `npm test` | Unit + HTTP tests |
| `npm run test:integration` | Real-Postgres tests (needs `TEST_DATABASE_URL`, truncates tables) |
| `npm run typecheck` / `npm run lint` | Type checking / oxlint |
| `npm run verify` | typecheck + lint + test + build |
| `npm run db:migrate` / `npm run db:seed` | Apply migrations / load dev data |
| `npm run admin:create` | Grant, change, or revoke admin access for a Supabase user |
| `npm run assets:cleanup` | Retry pending ImageKit deletions |

## Storefront cache purge

After every admin write that changes what the storefront shows (products, colors, images, categories, and orders that change stock) the API calls the storefront's revalidation webhook (`POST FRONTEND_REVALIDATE_URL`, header `x-revalidate-secret`, body `{ "tags": [...] }`). Set `FRONTEND_REVALIDATE_URL` and `REVALIDATE_SECRET` (the same value as in the storefront's `.env`); if either is missing the call is skipped and one warning is logged at startup. The call is fire-and-forget (5 s timeout, up to 3 attempts) and never fails an admin request. See [environment variables](./docs/development/environment.md).
