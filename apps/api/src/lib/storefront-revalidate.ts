import type { FastifyBaseLogger } from 'fastify'

/**
 * Tells the storefront to purge its cache after catalogue changes
 * (POST {FRONTEND_REVALIDATE_URL}, header x-revalidate-secret).
 *
 * Tags the storefront understands:
 *   products        home, category pages, search, sitemap, every listing
 *   categories      navigation, hero slides, category pages
 *   product:<slug>  one product detail page
 *
 * Fire-and-forget by design: a storefront outage must never fail or slow an
 * admin write. Call it only after the database transaction has committed.
 */

export interface RevalidateInput {
  /** Slugs of the product pages to purge (include both old and new on a slug change). */
  productSlugs?: readonly string[] | undefined
  categories?: boolean | undefined
}

export interface StorefrontRevalidator {
  revalidateStorefront(input?: RevalidateInput): void
}

type RevalidatorLogger = Pick<FastifyBaseLogger, 'warn' | 'error'>

export interface RevalidatorOptions {
  url: string | undefined
  secret: string | undefined
  logger: RevalidatorLogger
  /** Test seam; defaults to the global fetch. */
  fetch?: typeof fetch | undefined
  /** Keeps the work alive after the response on serverless platforms (Vercel waitUntil). */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined
  timeoutMs?: number | undefined
  maxAttempts?: number | undefined
  /** Delay before the first retry; it grows 4x per attempt. */
  retryDelayMs?: number | undefined
}

/** "products" is always purged; the rest is added on request and de-duplicated. */
export function buildRevalidateTags(input: RevalidateInput = {}): string[] {
  const tags = new Set<string>(['products'])
  if (input.categories) tags.add('categories')
  for (const slug of input.productSlugs ?? []) {
    if (slug) tags.add(`product:${slug}`)
  }
  return [...tags]
}

const NOOP: StorefrontRevalidator = { revalidateStorefront() {} }

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createStorefrontRevalidator(options: RevalidatorOptions): StorefrontRevalidator {
  const { url, secret, logger } = options
  if (!url || !secret) {
    logger.warn(
      'FRONTEND_REVALIDATE_URL / REVALIDATE_SECRET are not both set: storefront cache purging is disabled',
    )
    return NOOP
  }

  const send = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const maxAttempts = options.maxAttempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 250

  async function post(tags: string[]): Promise<void> {
    let lastFailure = 'unknown error'
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await send(url!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-revalidate-secret': secret! },
          body: JSON.stringify({ tags }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        await response.body?.cancel().catch(() => {})
        if (response.ok) return
        lastFailure = `HTTP ${response.status}`
        // A client error (e.g. 401 wrong secret) will not fix itself: do not retry.
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error)
      }
      if (attempt < maxAttempts) await sleep(retryDelayMs * 4 ** (attempt - 1))
    }
    logger.error({ tags, failure: lastFailure }, 'Storefront revalidation failed')
  }

  return {
    revalidateStorefront(input) {
      const tags = buildRevalidateTags(input)
      // post() never rejects, but guard anyway: this must not be able to throw.
      const work = post(tags).catch((error) => logger.error({ tags, err: error }, 'Storefront revalidation failed'))
      try {
        options.waitUntil?.(work)
      } catch (error) {
        logger.warn({ err: error }, 'Could not register storefront revalidation with the platform')
      }
    },
  }
}
