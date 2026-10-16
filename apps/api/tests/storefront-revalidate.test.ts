import { describe, expect, it, vi } from 'vitest'
import { buildRevalidateTags, createStorefrontRevalidator } from '../src/lib/storefront-revalidate.js'

const URL = 'https://shop.example.com/api/revalidate'
const SECRET = 'test-secret-value'

function setup(overrides: Partial<Parameters<typeof createStorefrontRevalidator>[0]> = {}) {
  const logger = { warn: vi.fn(), error: vi.fn() }
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{"revalidated":[]}', { status: 200 }))
  const waited: Promise<unknown>[] = []
  const revalidator = createStorefrontRevalidator({
    url: URL,
    secret: SECRET,
    logger,
    fetch: fetchMock as unknown as typeof fetch,
    waitUntil: (promise) => void waited.push(promise),
    retryDelayMs: 0,
    ...overrides,
  })
  const settle = () => Promise.all(waited)
  return { revalidator, logger, fetchMock, settle }
}

describe('buildRevalidateTags', () => {
  it('always includes products', () => {
    expect(buildRevalidateTags()).toEqual(['products'])
    expect(buildRevalidateTags({})).toEqual(['products'])
  })

  it('adds categories on request and one tag per product slug', () => {
    expect(buildRevalidateTags({ categories: true, productSlugs: ['a', 'b'] })).toEqual([
      'products',
      'categories',
      'product:a',
      'product:b',
    ])
  })

  it('de-duplicates tags and ignores empty slugs', () => {
    expect(buildRevalidateTags({ productSlugs: ['a', 'a', '', 'b', 'a'] })).toEqual(['products', 'product:a', 'product:b'])
  })
})

describe('createStorefrontRevalidator', () => {
  it('posts the tags with the shared secret header', async () => {
    const { revalidator, fetchMock, settle } = setup()

    revalidator.revalidateStorefront({ categories: true, productSlugs: ['classic-t-shirt'] })
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json', 'x-revalidate-secret': SECRET })
    expect(JSON.parse(init.body as string)).toEqual({ tags: ['products', 'categories', 'product:classic-t-shirt'] })
  })

  it('is skipped, with one startup warning, when the URL or the secret is missing', () => {
    for (const missing of [{ url: undefined }, { secret: undefined }, { url: undefined, secret: undefined }]) {
      const { revalidator, logger, fetchMock } = setup(missing)
      expect(logger.warn).toHaveBeenCalledTimes(1)

      revalidator.revalidateStorefront({ productSlugs: ['a'] })
      revalidator.revalidateStorefront()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledTimes(1)
    }
  })

  it('never throws and logs the tags when the storefront is down (after 3 attempts)', async () => {
    const { revalidator, logger, fetchMock, settle } = setup()
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))

    expect(() => revalidator.revalidateStorefront({ productSlugs: ['a'] })).not.toThrow()
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['products', 'product:a'], failure: 'connect ECONNREFUSED' }),
      'Storefront revalidation failed',
    )
  })

  it('retries server errors and stops as soon as one attempt succeeds', async () => {
    const { revalidator, logger, fetchMock, settle } = setup()
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('{}', { status: 200 }))

    revalidator.revalidateStorefront()
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('does not retry a rejected secret (401) and logs it without leaking the secret', async () => {
    const { revalidator, logger, fetchMock, settle } = setup()
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))

    revalidator.revalidateStorefront({ productSlugs: ['a'] })
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['products', 'product:a'], failure: 'HTTP 401' }),
      'Storefront revalidation failed',
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET)
  })

  it('aborts a hanging request after the timeout', async () => {
    const { revalidator, logger, fetchMock, settle } = setup({ timeoutMs: 20, maxAttempts: 1 })
    fetchMock.mockImplementation(
      (_url: unknown, init: unknown) =>
        new Promise((_resolve, reject) => {
          ;(init as RequestInit).signal?.addEventListener('abort', () => reject(new Error('timed out')))
        }) as Promise<Response>,
    )

    revalidator.revalidateStorefront()
    await settle()

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ failure: 'timed out' }), 'Storefront revalidation failed')
  })

  it('does not throw when the platform waitUntil hook throws', () => {
    const { revalidator, logger } = setup({
      waitUntil: () => {
        throw new Error('no request context')
      },
    })
    expect(() => revalidator.revalidateStorefront()).not.toThrow()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })
})
