import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bearer, buildTestApp, IDS, productRecord } from './helpers.js'
import type { TestApp } from './helpers.js'

const URL = 'https://shop.example.com/api/revalidate'
const SECRET = 'test-secret-value'

let t: TestApp
let webhook: ReturnType<typeof vi.fn>

beforeEach(async () => {
  webhook = vi.fn(async () => new Response('{"revalidated":[]}', { status: 200 }))
  t = await buildTestApp(
    { FRONTEND_REVALIDATE_URL: URL, REVALIDATE_SECRET: SECRET },
    { fetch: webhook as unknown as typeof fetch },
  )
})

/** The webhook is fire-and-forget: wait for it, then make sure no second call follows. */
async function webhookTags(expectedCalls = 1): Promise<string[]> {
  await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(expectedCalls))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(webhook).toHaveBeenCalledTimes(expectedCalls)
  const [url, init] = webhook.mock.calls[expectedCalls - 1] as [string, RequestInit]
  expect(url).toBe(URL)
  expect((init.headers as Record<string, string>)['x-revalidate-secret']).toBe(SECRET)
  return JSON.parse(init.body as string).tags
}

const lockedProduct = (overrides: Record<string, unknown> = {}) => ({
  id: IDS.product,
  slug: 'classic-t-shirt',
  status: 'draft',
  price: 25,
  compareAtPrice: null,
  publishedAt: null,
  ...overrides,
})

describe('storefront revalidation on product writes', () => {
  it('create: exactly one call with the new slug', async () => {
    t.repos.products.insertProduct.mockResolvedValue(IDS.product)
    t.repos.products.findById.mockResolvedValue(productRecord({ status: 'draft' }))

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: bearer('admin'),
      payload: { name: 'Classic T Shirt', slug: 'classic-t-shirt', price: 25, sku: 'TSHIRT-001' },
    })

    expect(res.statusCode).toBe(201)
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])
  })

  it('update: exactly one call, with the new slug and the product page that no longer exists', async () => {
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.findById.mockResolvedValue(productRecord({ slug: 'classic-tee' }))

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/products/${IDS.product}`,
      headers: bearer('admin'),
      payload: { slug: 'classic-tee', isBestSeller: true },
    })

    expect(res.statusCode).toBe(200)
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt', 'product:classic-tee'])
  })

  it('update without a slug change: one product tag', async () => {
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.findById.mockResolvedValue(productRecord())

    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/products/${IDS.product}`,
      headers: bearer('admin'),
      payload: { price: 20, compareAtPrice: null },
    })

    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])
  })

  it('update that changes the category also purges categories', async () => {
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.categoryExists.mockResolvedValue(true)
    t.repos.products.findById.mockResolvedValue(productRecord())

    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/products/${IDS.product}`,
      headers: bearer('admin'),
      payload: { categoryId: IDS.category },
    })

    expect(await webhookTags()).toEqual(['products', 'categories', 'product:classic-t-shirt'])
  })

  it('delete: exactly one call with the deleted slug', async () => {
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.listImageFileIdsForProduct.mockResolvedValue([])

    const res = await t.app.inject({ method: 'DELETE', url: `/api/admin/products/${IDS.product}`, headers: bearer('admin') })

    expect(res.statusCode).toBe(204)
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])
  })

  it('color update: purges the parent product page', async () => {
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct({ status: 'published' }))
    t.repos.products.findColor.mockResolvedValue({ id: IDS.colorBlack })
    t.repos.products.findById.mockResolvedValue(productRecord())

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/products/${IDS.product}/colors/${IDS.colorBlack}`,
      headers: bearer('admin'),
      payload: { name: 'Jet Black' },
    })

    expect(res.statusCode).toBe(200)
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])
  })

  it('image delete: purges the parent product page once, and nothing when the image is already gone', async () => {
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.findColor.mockResolvedValue({ id: IDS.colorBlack })
    t.repos.products.findImage.mockResolvedValue({ id: IDS.image1, isPrimary: false, imageKitFileId: 'file_1' })
    t.repos.products.countImages.mockResolvedValue(2)

    const url = `/api/admin/products/${IDS.product}/colors/${IDS.colorBlack}/images/${IDS.image1}`
    expect((await t.app.inject({ method: 'DELETE', url, headers: bearer('admin') })).statusCode).toBe(204)
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])

    t.repos.products.findImage.mockResolvedValue(null)
    expect((await t.app.inject({ method: 'DELETE', url, headers: bearer('admin') })).statusCode).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(webhook).toHaveBeenCalledTimes(1)
  })

  it('does not call the webhook when the write fails', async () => {
    t.repos.products.lockProduct.mockResolvedValue(null)

    const res = await t.app.inject({ method: 'DELETE', url: `/api/admin/products/${IDS.product}`, headers: bearer('admin') })

    expect(res.statusCode).toBe(404)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(webhook).not.toHaveBeenCalled()
  })

  it('the admin write still succeeds when the storefront is down', async () => {
    webhook.mockRejectedValue(new Error('connect ECONNREFUSED'))
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.listImageFileIdsForProduct.mockResolvedValue([])

    const res = await t.app.inject({ method: 'DELETE', url: `/api/admin/products/${IDS.product}`, headers: bearer('admin') })

    expect(res.statusCode).toBe(204)
  })

  it('the admin write still succeeds when the storefront rejects the secret', async () => {
    webhook.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    t.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    t.repos.products.listImageFileIdsForProduct.mockResolvedValue([])

    const res = await t.app.inject({ method: 'DELETE', url: `/api/admin/products/${IDS.product}`, headers: bearer('admin') })

    expect(res.statusCode).toBe(204)
    await vi.waitFor(() => expect(webhook).toHaveBeenCalledTimes(1)) // 4xx: no retries
  })
})

describe('storefront revalidation without configuration', () => {
  it('skips the call entirely and the API keeps working', async () => {
    const unconfigured = vi.fn()
    const app = await buildTestApp({}, { fetch: unconfigured as unknown as typeof fetch })
    app.repos.products.lockProduct.mockResolvedValue(lockedProduct())
    app.repos.products.listImageFileIdsForProduct.mockResolvedValue([])

    const res = await app.app.inject({ method: 'DELETE', url: `/api/admin/products/${IDS.product}`, headers: bearer('admin') })

    expect(res.statusCode).toBe(204)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unconfigured).not.toHaveBeenCalled()
  })
})

describe('storefront revalidation on category and order writes', () => {
  const category = {
    id: IDS.category,
    name: 'Shirts',
    slug: 'shirts',
    description: '',
    sortOrder: 0,
    isActive: true,
    productCount: 1,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  }

  it('category create: purges categories and products', async () => {
    t.repos.categories.insert.mockResolvedValue(IDS.category)
    t.repos.categories.findById.mockResolvedValue(category)

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/categories',
      headers: bearer('admin'),
      payload: { name: 'Shirts', slug: 'shirts' },
    })

    expect(res.statusCode).toBe(201)
    expect(await webhookTags()).toEqual(['products', 'categories'])
  })

  it('category rename: also purges the pages of the products in it', async () => {
    t.repos.categories.findById.mockResolvedValue(category)
    t.repos.categories.update.mockResolvedValue(true)
    t.repos.categories.listProductSlugs.mockResolvedValue(['classic-t-shirt', 'polo-shirt'])

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/categories/${IDS.category}`,
      headers: bearer('admin'),
      payload: { slug: 'tops' },
    })

    expect(res.statusCode).toBe(200)
    expect(await webhookTags()).toEqual(['products', 'categories', 'product:classic-t-shirt', 'product:polo-shirt'])
  })

  it('category update that does not rename it: no product pages', async () => {
    t.repos.categories.findById.mockResolvedValue(category)
    t.repos.categories.update.mockResolvedValue(true)

    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/categories/${IDS.category}`,
      headers: bearer('admin'),
      payload: { sortOrder: 3 },
    })

    expect(await webhookTags()).toEqual(['products', 'categories'])
    expect(t.repos.categories.listProductSlugs).not.toHaveBeenCalled()
  })

  it('checkout: purges the ordered products once', async () => {
    t.repos.orders.lockProductsForCheckout.mockResolvedValue([
      { id: IDS.product, name: 'Classic T Shirt', slug: 'classic-t-shirt', sku: 'TSHIRT-001', price: 19.99, stock: 5, status: 'published', colorCount: 1 },
    ])
    t.repos.orders.findColorsForCheckout.mockResolvedValue([
      { id: IDS.colorBlack, productId: IDS.product, name: 'Black', hexValue: '#000000', imageUrl: null },
    ])
    t.repos.orders.findOrCreateCustomer.mockResolvedValue(IDS.customer)
    t.repos.orders.insertOrder.mockResolvedValue({ id: IDS.order, orderNumber: 'ORD-001002', createdAt: new Date('2026-09-22T12:00:00Z') })

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: {
        customer: { email: 'jane@example.com', fullName: 'Jane Doe' },
        shippingAddress: { line1: '1 Main St', city: 'Springfield', postalCode: '62701', country: 'us' },
        items: [{ productId: IDS.product, colorId: IDS.colorBlack, quantity: 2 }],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])
  })

  it('cancelling an order restocks and purges the products in it', async () => {
    t.repos.orders.lockOrder.mockResolvedValue({ id: IDS.order, status: 'pending' })
    t.repos.orders.productSlugsForOrder.mockResolvedValue(['classic-t-shirt'])
    t.repos.orders.findById.mockResolvedValue({ id: IDS.order, status: 'cancelled' })

    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${IDS.order}/status`,
      headers: bearer('admin'),
      payload: { status: 'cancelled' },
    })

    expect(t.repos.orders.restockItems).toHaveBeenCalled()
    expect(await webhookTags()).toEqual(['products', 'product:classic-t-shirt'])
  })

  it('a status change that does not touch stock does not call the webhook', async () => {
    t.repos.orders.lockOrder.mockResolvedValue({ id: IDS.order, status: 'pending' })
    t.repos.orders.findById.mockResolvedValue({ id: IDS.order, status: 'processing' })

    await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${IDS.order}/status`,
      headers: bearer('admin'),
      payload: { status: 'processing' },
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(webhook).not.toHaveBeenCalled()
  })
})
