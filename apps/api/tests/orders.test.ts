import { beforeEach, describe, expect, it } from 'vitest'
import { canTransition } from '../src/modules/orders/order-status.js'
import { bearer, buildTestApp, IDS, orderRecord, USERS } from './helpers.js'
import type { TestApp } from './helpers.js'

let t: TestApp
beforeEach(async () => {
  t = await buildTestApp()
})

describe('order authorization', () => {
  it('requires authentication for every admin order endpoint', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/orders'],
      ['GET', `/api/admin/orders/${IDS.order}`],
      ['GET', `/api/admin/orders/${IDS.order}/items`],
      ['PATCH', `/api/admin/orders/${IDS.order}/status`],
    ] as const) {
      const res = await t.app.inject({ method, url, payload: method === 'PATCH' ? { status: 'processing' } : undefined })
      expect({ route: `${method} ${url}`, status: res.statusCode }).toEqual({ route: `${method} ${url}`, status: 401 })
    }
    expect(t.repos.orders.findById).not.toHaveBeenCalled()
  })

  it('forbids signed-in users who are not admins', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/admin/orders/${IDS.order}`, headers: bearer('customer') })
    expect(res.statusCode).toBe(403)
    expect(t.repos.orders.findById).not.toHaveBeenCalled()
  })

  it('allows staff to read orders', async () => {
    t.repos.orders.list.mockResolvedValue({ items: [], total: 0 })
    const res = await t.app.inject({ method: 'GET', url: '/api/admin/orders', headers: bearer('staff') })
    expect(res.statusCode).toBe(200)
  })
})

describe('order retrieval', () => {
  it('returns full order details with purchase-time item snapshots', async () => {
    t.repos.orders.findById.mockResolvedValue(orderRecord())

    const res = await t.app.inject({ method: 'GET', url: `/api/admin/orders/${IDS.order}`, headers: bearer('staff') })

    expect(res.statusCode).toBe(200)
    const { data } = res.json()
    expect(data).toMatchObject({
      id: IDS.order,
      orderNumber: 'ORD-001001',
      status: 'pending',
      paymentStatus: 'paid',
      allowedTransitions: ['processing', 'cancelled'],
      customer: { id: IDS.customer, fullName: 'Jane Doe', email: 'jane@example.com', phone: '+1 555 0100' },
      shippingAddress: { line1: '1 Main St', line2: null, city: 'Springfield', state: 'IL', postalCode: '62701', country: 'US' },
      subtotal: 50,
      shippingCost: 5,
      total: 55,
      createdAt: '2026-09-10T10:00:00.000Z',
    })
    expect(data.items).toEqual([
      {
        id: '77777777-7777-4777-8777-777777777777',
        productId: IDS.product,
        colorId: IDS.colorBlack,
        productName: 'Classic T Shirt (old name)',
        sku: 'TSHIRT-001',
        colorName: 'Black',
        colorHex: '#000000',
        imageUrl: expect.stringContaining('black-1.jpg'),
        quantity: 2,
        unitPrice: 25,
        subtotal: 50,
      },
    ])
    expect(data.history[0]).toMatchObject({ toStatus: 'pending', createdAt: '2026-09-10T10:00:00.000Z' })
  })

  it('returns 404 for an unknown order', async () => {
    t.repos.orders.findById.mockResolvedValue(null)
    const res = await t.app.inject({ method: 'GET', url: `/api/admin/orders/${IDS.order}`, headers: bearer('staff') })
    expect(res.statusCode).toBe(404)
  })

  it('GET /items returns the line items only', async () => {
    t.repos.orders.exists.mockResolvedValue(true)
    t.repos.orders.findItems.mockResolvedValue(orderRecord().items)
    const res = await t.app.inject({ method: 'GET', url: `/api/admin/orders/${IDS.order}/items`, headers: bearer('staff') })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })

  it('passes search, status, date and sort filters through', async () => {
    t.repos.orders.list.mockResolvedValue({ items: [], total: 0 })
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/admin/orders?search=jane&status=shipped&paymentStatus=paid&dateFrom=2026-09-01&dateTo=2026-09-30&sort=total-desc',
      headers: bearer('staff'),
    })
    expect(res.statusCode).toBe(200)
    const filters = t.repos.orders.list.mock.calls[0]![1]
    expect(filters).toMatchObject({ search: 'jane', status: 'shipped', paymentStatus: 'paid', sort: 'total-desc' })
    expect(filters.dateFrom.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    // A date-only dateTo includes the whole day.
    expect(filters.dateTo.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('rejects an inverted date range', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/admin/orders?dateFrom=2026-09-30&dateTo=2026-09-01',
      headers: bearer('staff'),
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('order status updates', () => {
  it('follows the lifecycle and records who changed it (from the token, not the body)', async () => {
    t.repos.orders.lockOrder.mockResolvedValue({ id: IDS.order, status: 'pending' })
    t.repos.orders.findById.mockResolvedValue(orderRecord({ status: 'processing' }))

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${IDS.order}/status`,
      headers: bearer('staff'),
      payload: { status: 'processing', note: 'Picked', changedBy: USERS.owner },
    })

    expect(res.statusCode).toBe(200)
    expect(t.repos.orders.updateStatus).toHaveBeenCalledWith(expect.anything(), IDS.order, 'processing')
    expect(t.repos.orders.insertHistory).toHaveBeenCalledWith(expect.anything(), {
      orderId: IDS.order,
      fromStatus: 'pending',
      toStatus: 'processing',
      changedBy: USERS.staff,
      note: 'Picked',
    })
    expect(t.repos.orders.restockItems).not.toHaveBeenCalled()
  })

  it('rejects invalid transitions with 422 INVALID_STATUS_TRANSITION', async () => {
    t.repos.orders.lockOrder.mockResolvedValue({ id: IDS.order, status: 'delivered' })
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${IDS.order}/status`,
      headers: bearer('admin'),
      payload: { status: 'pending' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', details: { from: 'delivered', to: 'pending', allowed: [] } })
    expect(t.repos.orders.updateStatus).not.toHaveBeenCalled()
  })

  it('restocks items when an order is cancelled', async () => {
    t.repos.orders.lockOrder.mockResolvedValue({ id: IDS.order, status: 'processing' })
    t.repos.orders.findById.mockResolvedValue(orderRecord({ status: 'cancelled' }))
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${IDS.order}/status`,
      headers: bearer('staff'),
      payload: { status: 'cancelled' },
    })
    expect(res.statusCode).toBe(200)
    expect(t.repos.orders.restockItems).toHaveBeenCalledWith(expect.anything(), IDS.order)
  })

  it('treats setting the current status as a no-op', async () => {
    t.repos.orders.lockOrder.mockResolvedValue({ id: IDS.order, status: 'shipped' })
    t.repos.orders.findById.mockResolvedValue(orderRecord({ status: 'shipped' }))
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/admin/orders/${IDS.order}/status`,
      headers: bearer('staff'),
      payload: { status: 'shipped' },
    })
    expect(res.statusCode).toBe(200)
    expect(t.repos.orders.insertHistory).not.toHaveBeenCalled()
  })

  it('encodes the documented lifecycle', () => {
    expect(canTransition('pending', 'processing')).toBe(true)
    expect(canTransition('pending', 'shipped')).toBe(false)
    expect(canTransition('shipped', 'cancelled')).toBe(false)
    expect(canTransition('cancelled', 'pending')).toBe(false)
  })
})

describe('storefront checkout (POST /api/store/orders)', () => {
  const checkout = (items: unknown[]) => ({
    customer: { email: 'Jane@Example.com', fullName: 'Jane Doe', phone: '+1 555 0100' },
    shippingAddress: { line1: '1 Main St', city: 'Springfield', state: 'IL', postalCode: '62701', country: 'us' },
    items,
  })

  function stubCatalog(overrides: Record<string, unknown> = {}) {
    t.repos.orders.lockProductsForCheckout.mockResolvedValue([
      { id: IDS.product, name: 'Classic T Shirt', slug: 'classic-t-shirt', sku: 'TSHIRT-001', price: 19.99, stock: 5, status: 'published', colorCount: 2, ...overrides },
    ])
    t.repos.orders.findColorsForCheckout.mockResolvedValue([
      { id: IDS.colorBlack, productId: IDS.product, name: 'Black', hexValue: '#000000', imageUrl: 'https://ik.imagekit.io/test-shop/b.jpg' },
    ])
    t.repos.orders.findOrCreateCustomer.mockResolvedValue(IDS.customer)
    t.repos.orders.insertOrder.mockResolvedValue({ id: IDS.order, orderNumber: 'ORD-001002', createdAt: new Date('2026-09-22T12:00:00Z') })
  }

  it('prices the order from the database, ignoring client-supplied prices', async () => {
    stubCatalog()
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: checkout([{ productId: IDS.product, colorId: IDS.colorBlack, quantity: 3, price: 0.01, unitPrice: 0.01 }]),
    })

    expect(res.statusCode).toBe(201)
    expect(res.json().data).toMatchObject({
      orderNumber: 'ORD-001002',
      status: 'pending',
      paymentStatus: 'pending',
      subtotal: 59.97,
      shippingCost: 5,
      total: 64.97,
      items: [{ productName: 'Classic T Shirt', colorName: 'Black', quantity: 3, unitPrice: 19.99, lineTotal: 59.97 }],
    })
    expect(t.repos.orders.insertItem).toHaveBeenCalledWith(expect.anything(), IDS.order, expect.objectContaining({
      productName: 'Classic T Shirt',
      productSku: 'TSHIRT-001',
      colorName: 'Black',
      unitPrice: 19.99,
      quantity: 3,
    }))
    expect(t.repos.orders.decrementStock).toHaveBeenCalledWith(expect.anything(), IDS.product, 3)
    expect(t.repos.orders.findOrCreateCustomer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ email: 'jane@example.com' }))
    expect(res.json().data).not.toHaveProperty('id')
  })

  it('applies free shipping above the threshold', async () => {
    stubCatalog({ price: 60 })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: checkout([{ productId: IDS.product, colorId: IDS.colorBlack, quantity: 2 }]),
    })
    expect(res.json().data).toMatchObject({ subtotal: 120, shippingCost: 0, total: 120 })
  })

  it('rejects quantities above available stock', async () => {
    stubCatalog({ stock: 2 })
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: checkout([
        { productId: IDS.product, colorId: IDS.colorBlack, quantity: 2 },
        { productId: IDS.product, colorId: IDS.colorBlack, quantity: 1 },
      ]),
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatchObject({ code: 'INSUFFICIENT_STOCK', details: { available: 2 } })
    expect(t.repos.orders.insertOrder).not.toHaveBeenCalled()
  })

  it('rejects unpublished products and colors from other products', async () => {
    stubCatalog({ status: 'draft' })
    let res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: checkout([{ productId: IDS.product, colorId: IDS.colorBlack, quantity: 1 }]),
    })
    expect(res.json().error.code).toBe('PRODUCT_UNAVAILABLE')

    stubCatalog()
    res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: checkout([{ productId: IDS.product, colorId: IDS.colorWhite, quantity: 1 }]),
    })
    expect(res.json().error.code).toBe('PRODUCT_UNAVAILABLE')
  })

  it('validates the checkout body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/store/orders',
      payload: { customer: { email: 'nope', fullName: '' }, shippingAddress: {}, items: [] },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('VALIDATION_ERROR')
  })
})
