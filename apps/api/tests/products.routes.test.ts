import { beforeEach, describe, expect, it } from 'vitest'
import { bearer, buildTestApp, IDS, IMAGEKIT_ENDPOINT, productRecord } from './helpers.js'
import type { TestApp } from './helpers.js'

let t: TestApp
beforeEach(async () => {
  t = await buildTestApp()
})

describe('GET /api/store/products/:slug (storefront product with colors and images)', () => {
  it('returns every color with its images in a single response', async () => {
    t.repos.products.findPublishedBySlug.mockResolvedValue(productRecord())

    const res = await t.app.inject({ method: 'GET', url: '/api/store/products/classic-t-shirt' })

    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.colors.map((c: { name: string }) => c.name)).toEqual(['Black', 'White'])
    expect(data.colors[0].images).toEqual([
      { id: IDS.image1, url: `${IMAGEKIT_ENDPOINT}/products/black-1.jpg`, thumbUrl: `${IMAGEKIT_ENDPOINT}/products/black-1.jpg?tr=w-400,h-400,c-at_max`, alt: 'Front', sortOrder: 0, isPrimary: true },
      { id: IDS.image2, url: `${IMAGEKIT_ENDPOINT}/products/black-2.jpg`, thumbUrl: `${IMAGEKIT_ENDPOINT}/products/black-2.jpg?tr=w-400,h-400,c-at_max`, alt: null, sortOrder: 1, isPrimary: false },
    ])
    expect(data.colors[1].images).toHaveLength(1)
    expect(t.repos.products.findPublishedBySlug).toHaveBeenCalledTimes(1)
  })

  it('exposes only public fields', async () => {
    t.repos.products.findPublishedBySlug.mockResolvedValue(productRecord())
    const { data } = (await t.app.inject({ method: 'GET', url: '/api/store/products/classic-t-shirt' })).json()

    expect(Object.keys(data).sort()).toEqual(
      ['category', 'colors', 'compareAtPrice', 'currency', 'description', 'id', 'inStock', 'isBestSeller', 'isFeatured', 'name', 'price', 'sku', 'slug'].sort(),
    )
    expect(data.category).toEqual({ name: 'Shirts', slug: 'shirts' })
    expect(data.inStock).toBe(true)
    const serialized = JSON.stringify(data)
    for (const secret of ['imageKitFileId', 'file_black_1', 'stock', 'status', 'createdAt', 'categoryId']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('is cacheable by CDNs and browsers', async () => {
    t.repos.products.findPublishedBySlug.mockResolvedValue(productRecord())
    const res = await t.app.inject({ method: 'GET', url: '/api/store/products/classic-t-shirt' })
    expect(res.headers['cache-control']).toMatch(/^public, max-age=60/)
  })

  it('returns 404 for unknown or unpublished products', async () => {
    t.repos.products.findPublishedBySlug.mockResolvedValue(null)
    const res = await t.app.inject({ method: 'GET', url: '/api/store/products/draft-product' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Product not found' } })
  })
})

describe('GET /api/store/products', () => {
  it('lists only published products with the pagination envelope', async () => {
    t.repos.products.list.mockResolvedValue({
      items: [
        {
          ...productRecord(),
          primaryImageUrl: `${IMAGEKIT_ENDPOINT}/products/black-1.jpg`,
          colors: [{ id: IDS.colorBlack, name: 'Black', hexValue: '#000000' }],
        },
      ],
      total: 41,
    })

    const res = await t.app.inject({ method: 'GET', url: '/api/store/products?page=2&pageSize=20&category=shirts&sort=price-asc' })

    expect(res.statusCode).toBe(200)
    expect(res.json().pagination).toEqual({ page: 2, pageSize: 20, total: 41, totalPages: 3 })
    expect(t.repos.products.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishedOnly: true, categorySlug: 'shirts', sort: 'price-asc' }),
      { page: 2, pageSize: 20 },
    )
    const [item] = res.json().data
    expect(item).toMatchObject({ slug: 'classic-t-shirt', imageUrl: `${IMAGEKIT_ENDPOINT}/products/black-1.jpg`, currency: 'USD' })
    expect(item).not.toHaveProperty('status')
  })

  it('caps page size at 100', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/store/products?pageSize=1000' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })
})

describe('admin product reads', () => {
  it('GET /api/products/:id returns admin fields including ImageKit file ids', async () => {
    t.repos.products.findById.mockResolvedValue(productRecord({ status: 'draft' }))
    const res = await t.app.inject({ method: 'GET', url: `/api/products/${IDS.product}`, headers: bearer('staff') })

    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data.status).toBe('draft')
    expect(data.colors[0]).toMatchObject({ primaryImageId: IDS.image1, hexValue: '#000000' })
    expect(data.colors[0].images[0]).toMatchObject({ imageKitFileId: 'file_black_1', imageUrl: expect.any(String), thumbUrl: expect.any(String) })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('GET /api/products requires an admin', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/products' })).statusCode).toBe(401)
    expect((await t.app.inject({ method: 'GET', url: '/api/products', headers: bearer('customer') })).statusCode).toBe(403)
  })

  it('GET /api/products passes filters and sorting to the repository', async () => {
    t.repos.products.list.mockResolvedValue({ items: [], total: 0 })
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/products?search=%20tee%20&status=draft&categoryId=${IDS.category}&sort=name-asc`,
      headers: bearer('staff'),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } })
    expect(t.repos.products.list).toHaveBeenCalledWith(
      expect.anything(),
      { search: 'tee', status: 'draft', categoryId: IDS.category, featured: undefined, sort: 'name-asc' },
      { page: 1, pageSize: 20 },
    )
  })
})

describe('featured / best-seller flags', () => {
  const flagged = (overrides: Record<string, unknown> = {}) => ({
    ...productRecord({ isFeatured: true, isBestSeller: true, ...overrides }),
    primaryImageUrl: null,
    colors: [],
  })

  it('storefront list exposes the flags and passes sort=best-seller and featured=true through', async () => {
    t.repos.products.list.mockResolvedValue({ items: [flagged()], total: 1 })

    const res = await t.app.inject({ method: 'GET', url: '/api/store/products?sort=best-seller&featured=true' })

    expect(res.statusCode).toBe(200)
    expect(res.json().data[0]).toMatchObject({ isFeatured: true, isBestSeller: true })
    expect(t.repos.products.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ publishedOnly: true, featured: true, sort: 'best-seller' }),
      { page: 1, pageSize: 20 },
    )
  })

  it('storefront accepts sort=featured and rejects a non-boolean featured value', async () => {
    t.repos.products.list.mockResolvedValue({ items: [], total: 0 })
    expect((await t.app.inject({ method: 'GET', url: '/api/store/products?sort=featured' })).statusCode).toBe(200)
    expect((await t.app.inject({ method: 'GET', url: '/api/store/products?featured=yes' })).statusCode).toBe(422)
  })

  it('admin list supports the featured and best-seller sorts and the featured filter', async () => {
    t.repos.products.list.mockResolvedValue({ items: [flagged()], total: 1 })

    const res = await t.app.inject({ method: 'GET', url: '/api/products?sort=best-seller&featured=false', headers: bearer('staff') })

    expect(res.statusCode).toBe(200)
    expect(res.json().data[0]).toMatchObject({ isFeatured: true, isBestSeller: true })
    expect(t.repos.products.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ featured: false, sort: 'best-seller' }),
      { page: 1, pageSize: 20 },
    )
  })
})

describe('admin product writes', () => {
  it('POST /api/admin/products creates a product and returns 201', async () => {
    t.repos.products.categoryExists.mockResolvedValue(true)
    t.repos.products.insertProduct.mockResolvedValue(IDS.product)
    t.repos.products.insertColor.mockResolvedValue(IDS.colorBlack)
    t.repos.products.insertImage.mockResolvedValue(IDS.image1)
    t.repos.products.findById.mockResolvedValue(productRecord({ status: 'draft' }))

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: bearer('admin'),
      payload: {
        name: 'Classic T Shirt',
        slug: 'classic-t-shirt',
        price: 25,
        sku: 'TSHIRT-001',
        categoryId: IDS.category,
        colors: [
          {
            name: 'Black',
            hexValue: '#000',
            images: [{ imageUrl: `${IMAGEKIT_ENDPOINT}/products/file_1.jpg`, imageKitFileId: 'file_1' }],
          },
        ],
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.headers.location).toBe(`/api/products/${IDS.product}`)
    expect(t.repos.products.insertProduct).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'draft', stock: 0, compareAtPrice: null, description: '', isFeatured: false, isBestSeller: false }),
    )
    // Hex colors are normalised to upper case.
    expect(t.repos.products.insertColor).toHaveBeenCalledWith(expect.anything(), IDS.product, { name: 'Black', hexValue: '#000', sortOrder: 0 })
  })

  it('PATCH /api/admin/products/:id/colors/:colorId updates a color', async () => {
    t.repos.products.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'published', price: 25, compareAtPrice: null, publishedAt: null })
    t.repos.products.findColor.mockResolvedValue({ id: IDS.colorBlack })
    t.repos.products.findById.mockResolvedValue(productRecord())

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/products/${IDS.product}/colors/${IDS.colorBlack}`,
      headers: bearer('admin'),
      payload: { hexValue: '#0a0a0a' },
    })

    expect(res.statusCode).toBe(200)
    expect(t.repos.products.updateColor).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack, { hexValue: '#0A0A0A' })
  })

  it('DELETE image returns 204', async () => {
    t.repos.products.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    t.repos.products.findColor.mockResolvedValue({ id: IDS.colorBlack })
    t.repos.products.findImage.mockResolvedValue(null)
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/admin/products/${IDS.product}/colors/${IDS.colorBlack}/images/${IDS.image1}`,
      headers: bearer('admin'),
    })
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
  })
})

describe('validation failures', () => {
  it('returns field-level details for an invalid product body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: bearer('admin'),
      payload: { name: '', slug: 'Not A Slug', price: -5, sku: 'X' },
    })

    expect(res.statusCode).toBe(422)
    const { error } = res.json()
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.message).toBe('Invalid request')
    const paths = error.details.map((d: { path: string }) => d.path)
    expect(paths).toEqual(expect.arrayContaining(['name', 'slug', 'price']))
    expect(error.details[0].location).toBe('body')
    expect(t.repos.products.insertProduct).not.toHaveBeenCalled()
  })

  it('rejects compareAtPrice lower than price', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: bearer('admin'),
      payload: { name: 'X', slug: 'x', price: 20, compareAtPrice: 10, sku: 'X-1' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.details[0].path).toBe('compareAtPrice')
  })

  it('rejects duplicate color names and non-ImageKit-shaped image metadata', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/admin/products',
      headers: bearer('admin'),
      payload: {
        name: 'X',
        slug: 'x',
        price: 20,
        sku: 'X-1',
        colors: [
          { name: 'Black', hexValue: '#000000', images: [{ imageUrl: 'http://insecure.example.com/a.jpg', imageKitFileId: 'a' }] },
          { name: 'black', hexValue: 'not-a-hex' },
        ],
      },
    })
    expect(res.statusCode).toBe(422)
    const paths = res.json().error.details.map((d: { path: string }) => d.path)
    expect(paths).toEqual(expect.arrayContaining(['colors.0.images.0.imageUrl', 'colors.1.hexValue']))
  })

  it('rejects an empty PATCH body', async () => {
    const res = await t.app.inject({ method: 'PATCH', url: `/api/admin/products/${IDS.product}`, headers: bearer('admin'), payload: {} })
    expect(res.statusCode).toBe(422)
  })

  it('rejects malformed route params', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/products/not-a-uuid', headers: bearer('staff') })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.details[0]).toMatchObject({ location: 'params', path: 'id' })
  })

  it('rejects malformed query params', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/products?status=deleted&page=0', headers: bearer('staff') })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['status', 'page']))
  })
})
