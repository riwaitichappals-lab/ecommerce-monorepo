import { loadEnvFiles } from './env-file.js'
import { z } from 'zod'

/**
 * Environment configuration. Parsed once at startup; the process exits with a
 * readable message if anything required is missing or malformed.
 *
 * Every variable is documented in docs/development/environment.md.
 */

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const csv = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: booleanString.default(false),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: booleanString.default(true),

  SUPABASE_URL: z.url(),
  /** Only used for token verification with the legacy HS256 JWT secret. */
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  /** Not used by the server at runtime; accepted so a shared .env does not fail validation. */
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  IMAGEKIT_PUBLIC_KEY: z.string().min(1),
  IMAGEKIT_PRIVATE_KEY: z.string().min(1),
  IMAGEKIT_URL_ENDPOINT: z.url().transform((value) => value.replace(/\/+$/, '')),
  IMAGEKIT_UPLOAD_FOLDER: z.string().default('/products'),
  IMAGEKIT_VERIFY_UPLOADS: booleanString.default(true),

  CORS_ORIGIN: csv.default([]),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  CHECKOUT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  STORE_CACHE_MAX_AGE: z.coerce.number().int().nonnegative().default(60),
  CURRENCY: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('USD'),
  SHIPPING_FLAT_RATE: z.coerce.number().nonnegative().default(5),
  FREE_SHIPPING_THRESHOLD: z.coerce.number().nonnegative().default(100),

  ASSET_CLEANUP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300_000),
  ENABLE_API_DOCS: booleanString.optional(),

  /** Storefront cache-purge webhook. Both must be set, otherwise purging is skipped. */
  FRONTEND_REVALIDATE_URL: z.url().optional(),
  REVALIDATE_SECRET: z.string().min(1).optional(),
})

export type Env = z.infer<typeof envSchema>

export interface AppConfig {
  env: Env['NODE_ENV']
  isProduction: boolean
  host: string
  port: number
  logLevel: Env['LOG_LEVEL']
  trustProxy: boolean
  database: { url: string; poolMax: number; ssl: boolean }
  supabase: { url: string; jwtSecret: string | undefined }
  imagekit: {
    publicKey: string
    privateKey: string
    urlEndpoint: string
    uploadFolder: string
    verifyUploads: boolean
  }
  cors: { origins: string[] }
  rateLimit: { max: number; timeWindow: string; checkoutMax: number }
  store: { cacheMaxAge: number }
  commerce: { currency: string; shippingFlatRate: number; freeShippingThreshold: number }
  assetCleanupIntervalMs: number
  apiDocsEnabled: boolean
  storefront: { revalidateUrl: string | undefined; revalidateSecret: string | undefined }
}

export function parseConfig(source: NodeJS.ProcessEnv): AppConfig {
  // `KEY=` in a .env file means "not set", so defaults apply.
  const defined = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ''))
  const result = envSchema.safeParse(defined)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }

  const env = result.data
  const isProduction = env.NODE_ENV === 'production'

  if (isProduction && env.CORS_ORIGIN.length === 0) {
    throw new Error('Invalid environment configuration:\n  - CORS_ORIGIN: required in production')
  }

  return {
    env: env.NODE_ENV,
    isProduction,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    trustProxy: env.TRUST_PROXY,
    database: { url: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL },
    supabase: { url: env.SUPABASE_URL.replace(/\/+$/, ''), jwtSecret: env.SUPABASE_JWT_SECRET },
    imagekit: {
      publicKey: env.IMAGEKIT_PUBLIC_KEY,
      privateKey: env.IMAGEKIT_PRIVATE_KEY,
      urlEndpoint: env.IMAGEKIT_URL_ENDPOINT,
      uploadFolder: env.IMAGEKIT_UPLOAD_FOLDER,
      verifyUploads: env.IMAGEKIT_VERIFY_UPLOADS,
    },
    cors: { origins: env.CORS_ORIGIN },
    rateLimit: {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW,
      checkoutMax: env.CHECKOUT_RATE_LIMIT_MAX,
    },
    store: { cacheMaxAge: env.STORE_CACHE_MAX_AGE },
    commerce: {
      currency: env.CURRENCY,
      shippingFlatRate: env.SHIPPING_FLAT_RATE,
      freeShippingThreshold: env.FREE_SHIPPING_THRESHOLD,
    },
    assetCleanupIntervalMs: env.ASSET_CLEANUP_INTERVAL_MS,
    apiDocsEnabled: env.ENABLE_API_DOCS ?? !isProduction,
    storefront: { revalidateUrl: env.FRONTEND_REVALIDATE_URL, revalidateSecret: env.REVALIDATE_SECRET },
  }
}

/** Loads `.env` files (if present) into process.env and parses it. */
export function loadConfig(): AppConfig {
  loadEnvFiles()
  return parseConfig(process.env)
}
