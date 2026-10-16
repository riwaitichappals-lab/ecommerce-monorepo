// Shared bootstrap for Vercel functions. Files prefixed with "_" are not routed.
// Imports the compiled output (`pnpm build` → dist/), which vercel.json bundles via includeFiles.
import { waitUntil } from '@vercel/functions'
import { loadConfig } from '../dist/app/config.js'
import { buildApp } from '../dist/app/server.js'
import { createSupabaseTokenVerifier } from '../dist/lib/auth/token-verifier.js'
import { createDatabase } from '../dist/lib/db.js'
import { createImageKitClient } from '../dist/lib/imagekit.js'

let instance

/** Builds the Fastify app once per warm function instance. */
export function getApp() {
  instance ??= (async () => {
    const config = loadConfig()
    const db = createDatabase(config.database)
    const built = await buildApp(config, {
      db,
      tokenVerifier: createSupabaseTokenVerifier({ supabaseUrl: config.supabase.url, jwtSecret: config.supabase.jwtSecret }),
      imagekit: createImageKitClient(config.imagekit),
      // Keeps the storefront cache-purge call alive after the response is sent.
      waitUntil,
    })
    await built.app.ready()
    return built
  })().catch((error) => {
    instance = undefined // allow a retry on the next invocation
    throw error
  })
  return instance
}
