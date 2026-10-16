import type { Database } from '../../lib/db.js'
import { AppError, notFound } from '../../lib/errors.js'
import { fromCents, toCents } from '../../lib/money.js'
import type { PageRequest } from '../../lib/pagination.js'
import type { StorefrontRevalidator } from '../../lib/storefront-revalidate.js'
import { ORDER_TRANSITIONS, canTransition } from './order-status.js'
import type { OrdersRepository } from './orders.repository.js'
import type { CheckoutInput, OrderItemRecord, OrderListFilters, OrderStatus } from './orders.types.js'

export interface CommerceSettings {
  currency: string
  shippingFlatRate: number
  freeShippingThreshold: number
}

/**
 * Order business logic.
 *  - Prices, availability and totals are always computed here from the
 *    database. The client only sends product IDs, color IDs and quantities.
 *  - Order items snapshot product name, SKU, color, image and unit price at
 *    purchase time (docs/decisions/003-order-snapshots.md).
 *  - Status changes follow ORDER_TRANSITIONS and are recorded in
 *    order_status_history in the same transaction.
 */
export class OrdersService {
  constructor(
    private readonly db: Database,
    private readonly repository: OrdersRepository,
    private readonly commerce: CommerceSettings,
    private readonly revalidator: StorefrontRevalidator,
  ) {}

  list(filters: OrderListFilters, page: PageRequest) {
    return this.repository.list(this.db.sql, filters, page)
  }

  async getById(id: string) {
    const order = await this.repository.findById(this.db.sql, id)
    if (!order) throw notFound('Order')
    return order
  }

  async getItems(id: string): Promise<OrderItemRecord[]> {
    if (!(await this.repository.exists(this.db.sql, id))) throw notFound('Order')
    return this.repository.findItems(this.db.sql, id)
  }

  async updateStatus(id: string, input: { status: OrderStatus; note?: string | undefined }, adminId: string) {
    let restockedSlugs: string[] | null = null
    await this.db.transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, id)
      if (!order) throw notFound('Order')
      if (order.status === input.status) return // idempotent no-op

      if (!canTransition(order.status, input.status)) {
        throw new AppError(
          422,
          'INVALID_STATUS_TRANSITION',
          `Cannot change order status from ${order.status} to ${input.status}`,
          { from: order.status, to: input.status, allowed: ORDER_TRANSITIONS[order.status] },
        )
      }

      await this.repository.updateStatus(tx, id, input.status)
      await this.repository.insertHistory(tx, {
        orderId: id,
        fromStatus: order.status,
        toStatus: input.status,
        changedBy: adminId,
        note: input.note ?? null,
      })
      if (input.status === 'cancelled') {
        await this.repository.restockItems(tx, id)
        restockedSlugs = await this.repository.productSlugsForOrder(tx, id)
      }
    })
    // Restocking changes availability on the storefront.
    if (restockedSlugs) this.revalidator.revalidateStorefront({ productSlugs: restockedSlugs })
    return this.getById(id)
  }

  /**
   * Guest checkout. Creates the customer (if new), address, order and items
   * atomically, decrementing stock under row locks. Payment capture is not
   * integrated yet: orders are created with payment_status = 'pending'.
   */
  async checkout(input: CheckoutInput) {
    // Merge duplicate lines (same product + color).
    const lines = new Map<string, { productId: string; colorId: string | undefined; quantity: number }>()
    for (const item of input.items) {
      const key = `${item.productId}:${item.colorId ?? ''}`
      const existing = lines.get(key)
      if (existing) existing.quantity += item.quantity
      else lines.set(key, { productId: item.productId, colorId: item.colorId, quantity: item.quantity })
    }

    const productIds = [...new Set([...lines.values()].map((line) => line.productId))]
    const colorIds = [...new Set([...lines.values()].flatMap((line) => (line.colorId ? [line.colorId] : [])))]

    const orderedSlugs: string[] = []

    const result = await this.db.transaction(async (tx) => {
      const products = new Map(
        (await this.repository.lockProductsForCheckout(tx, productIds)).map((product) => [product.id, product]),
      )
      const colors = new Map((await this.repository.findColorsForCheckout(tx, colorIds)).map((color) => [color.id, color]))

      const requestedPerProduct = new Map<string, number>()
      const items: Omit<OrderItemRecord, 'id'>[] = []
      let subtotalCents = 0

      for (const line of lines.values()) {
        const product = products.get(line.productId)
        if (!product || product.status !== 'published') {
          throw new AppError(422, 'PRODUCT_UNAVAILABLE', 'A product in the cart is no longer available', {
            productId: line.productId,
          })
        }

        let color = null
        if (line.colorId) {
          color = colors.get(line.colorId)
          if (!color || color.productId !== product.id) {
            throw new AppError(422, 'PRODUCT_UNAVAILABLE', 'The selected color is not available for this product', {
              productId: product.id,
              colorId: line.colorId,
            })
          }
        } else if (product.colorCount > 0) {
          throw new AppError(422, 'VALIDATION_ERROR', 'A color must be selected for this product', {
            productId: product.id,
          })
        }

        const requested = (requestedPerProduct.get(product.id) ?? 0) + line.quantity
        requestedPerProduct.set(product.id, requested)
        if (requested > product.stock) {
          throw new AppError(422, 'INSUFFICIENT_STOCK', `Not enough stock for ${product.name}`, {
            productId: product.id,
            available: product.stock,
          })
        }

        const unitCents = toCents(product.price)
        const lineCents = unitCents * line.quantity
        subtotalCents += lineCents
        items.push({
          productId: product.id,
          productColorId: color?.id ?? null,
          productName: product.name,
          productSku: product.sku,
          colorName: color?.name ?? null,
          colorHex: color?.hexValue ?? null,
          imageUrl: color?.imageUrl ?? null,
          unitPrice: fromCents(unitCents),
          quantity: line.quantity,
          lineTotal: fromCents(lineCents),
        })
      }

      const shippingCents =
        subtotalCents >= toCents(this.commerce.freeShippingThreshold) ? 0 : toCents(this.commerce.shippingFlatRate)
      const totalCents = subtotalCents + shippingCents

      for (const [productId, quantity] of requestedPerProduct) {
        await this.repository.decrementStock(tx, productId, quantity)
        orderedSlugs.push(products.get(productId)!.slug)
      }

      const email = input.customer.email.toLowerCase()
      const phone = input.customer.phone ?? null
      const shipping = {
        line1: input.shippingAddress.line1,
        line2: input.shippingAddress.line2 ?? null,
        city: input.shippingAddress.city,
        state: input.shippingAddress.state ?? '',
        postalCode: input.shippingAddress.postalCode,
        country: input.shippingAddress.country,
      }

      const customerId = await this.repository.findOrCreateCustomer(tx, {
        email,
        fullName: input.customer.fullName,
        phone,
      })
      await this.repository.insertAddress(tx, customerId, shipping)

      const order = await this.repository.insertOrder(tx, {
        customerId,
        customerEmail: email,
        customerName: input.customer.fullName,
        customerPhone: phone,
        shipping,
        currency: this.commerce.currency,
        subtotal: fromCents(subtotalCents),
        shippingCost: fromCents(shippingCents),
        total: fromCents(totalCents),
      })
      for (const item of items) await this.repository.insertItem(tx, order.id, item)
      await this.repository.insertHistory(tx, {
        orderId: order.id,
        fromStatus: null,
        toStatus: 'pending',
        changedBy: null,
        note: 'Order placed',
      })

      return {
        orderNumber: order.orderNumber,
        status: 'pending' as const,
        paymentStatus: 'pending' as const,
        currency: this.commerce.currency,
        items: items.map((item) => ({
          productName: item.productName,
          colorName: item.colorName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
        })),
        subtotal: fromCents(subtotalCents),
        shippingCost: fromCents(shippingCents),
        total: fromCents(totalCents),
        createdAt: order.createdAt.toISOString(),
      }
    })

    // Stock changed: refresh the storefront (after the commit, never inside the transaction).
    this.revalidator.revalidateStorefront({ productSlugs: orderedSlugs })
    return result
  }
}
