import type { Executor, Fragment } from '../../lib/db.js'
import { likePattern, pageOffset } from '../../lib/pagination.js'
import type { Page, PageRequest } from '../../lib/pagination.js'
import type {
  OrderItemRecord,
  OrderListFilters,
  OrderListRecord,
  OrderRecord,
  OrderSort,
  OrderStatus,
} from './orders.types.js'

function orderBy(sql: Executor, sort: OrderSort): Fragment {
  switch (sort) {
    case 'created-asc':
      return sql`o.created_at asc, o.id`
    case 'total-desc':
      return sql`o.total desc, o.created_at desc, o.id`
    case 'total-asc':
      return sql`o.total asc, o.created_at desc, o.id`
    case 'created-desc':
      return sql`o.created_at desc, o.id`
  }
}

function listConditions(sql: Executor, filters: OrderListFilters): Fragment {
  const conditions = [sql`true`]
  if (filters.status) conditions.push(sql`o.status = ${filters.status}`)
  if (filters.paymentStatus) conditions.push(sql`o.payment_status = ${filters.paymentStatus}`)
  if (filters.customerId) conditions.push(sql`o.customer_id = ${filters.customerId}`)
  if (filters.dateFrom) conditions.push(sql`o.created_at >= ${filters.dateFrom}`)
  if (filters.dateTo) conditions.push(sql`o.created_at < ${filters.dateTo}`)
  if (filters.search) {
    const pattern = likePattern(filters.search)
    conditions.push(
      sql`(o.order_number ilike ${pattern} or o.customer_email ilike ${pattern} or o.customer_name ilike ${pattern})`,
    )
  }
  return conditions.reduce((acc, condition) => sql`${acc} and ${condition}`)
}

const ITEM_COLUMNS = (sql: Executor) => sql`
  oi.id, oi.product_id, oi.product_color_id, oi.product_name, oi.product_sku,
  oi.color_name, oi.color_hex, oi.image_url,
  oi.unit_price::float8 as unit_price, oi.quantity, oi.line_total::float8 as line_total
`

export interface CheckoutProductRow {
  id: string
  name: string
  slug: string
  sku: string
  price: number
  stock: number
  status: string
  colorCount: number
}

export interface CheckoutColorRow {
  id: string
  productId: string
  name: string
  hexValue: string
  imageUrl: string | null
}

export const ordersRepository = {
  async list(sql: Executor, filters: OrderListFilters, page: PageRequest): Promise<Page<OrderListRecord>> {
    const where = listConditions(sql, filters)
    const [items, [count]] = await Promise.all([
      sql<OrderListRecord[]>`
        select o.id, o.order_number, o.customer_id, o.customer_name, o.customer_email,
               o.status, o.payment_status, o.total::float8 as total, o.currency, o.created_at,
               (select coalesce(sum(oi.quantity), 0)::int from order_items oi where oi.order_id = o.id) as item_count
        from orders o
        where ${where}
        order by ${orderBy(sql, filters.sort)}
        limit ${page.pageSize} offset ${pageOffset(page)}
      `,
      sql<{ total: number }[]>`select count(*)::int as total from orders o where ${where}`,
    ])
    return { items, total: count?.total ?? 0 }
  },

  async findById(sql: Executor, id: string): Promise<OrderRecord | null> {
    const [order] = await sql<Omit<OrderRecord, 'items'>[]>`
      select o.id, o.order_number, o.status, o.payment_status, o.currency,
             o.customer_id, o.customer_name, o.customer_email, o.customer_phone,
             o.shipping_line1, o.shipping_line2, o.shipping_city, o.shipping_state,
             o.shipping_postal_code, o.shipping_country,
             o.subtotal::float8 as subtotal, o.shipping_cost::float8 as shipping_cost, o.total::float8 as total,
             o.created_at, o.updated_at,
             coalesce((
               select json_agg(json_build_object(
                        'fromStatus', h.from_status,
                        'toStatus', h.to_status,
                        'changedByName', ap.full_name,
                        'note', h.note,
                        'createdAt', h.created_at
                      ) order by h.created_at)
               from order_status_history h
               left join admin_profiles ap on ap.id = h.changed_by
               where h.order_id = o.id
             ), '[]'::json) as history
      from orders o
      where o.id = ${id}
    `
    if (!order) return null
    const items = await this.findItems(sql, id)
    return { ...order, items }
  },

  async findItems(sql: Executor, orderId: string): Promise<OrderItemRecord[]> {
    return sql<OrderItemRecord[]>`
      select ${ITEM_COLUMNS(sql)}
      from order_items oi
      where oi.order_id = ${orderId}
      order by oi.created_at, oi.id
    `
  },

  async exists(sql: Executor, id: string): Promise<boolean> {
    const [row] = await sql`select 1 from orders where id = ${id}`
    return Boolean(row)
  },

  async lockOrder(sql: Executor, id: string): Promise<{ id: string; status: OrderStatus } | null> {
    const [row] = await sql<{ id: string; status: OrderStatus }[]>`
      select id, status from orders where id = ${id} for update
    `
    return row ?? null
  },

  async updateStatus(sql: Executor, id: string, status: OrderStatus): Promise<void> {
    await sql`update orders set status = ${status} where id = ${id}`
  },

  async insertHistory(
    sql: Executor,
    entry: { orderId: string; fromStatus: OrderStatus | null; toStatus: OrderStatus; changedBy: string | null; note: string | null },
  ): Promise<void> {
    await sql`
      insert into order_status_history (order_id, from_status, to_status, changed_by, note)
      values (${entry.orderId}, ${entry.fromStatus}, ${entry.toStatus}, ${entry.changedBy}, ${entry.note})
    `
  },

  /** Returns the order's quantities to stock (products that still exist). */
  async restockItems(sql: Executor, orderId: string): Promise<void> {
    await sql`
      update products p
      set stock = p.stock + agg.quantity
      from (
        select product_id, sum(quantity)::int as quantity
        from order_items
        where order_id = ${orderId} and product_id is not null
        group by product_id
      ) agg
      where p.id = agg.product_id
    `
  },

  /** Slugs of the products an order contains (for storefront cache purging). */
  async productSlugsForOrder(sql: Executor, orderId: string): Promise<string[]> {
    const rows = await sql<{ slug: string }[]>`
      select distinct p.slug
      from order_items oi
      join products p on p.id = oi.product_id
      where oi.order_id = ${orderId}
    `
    return rows.map((row) => row.slug)
  },

  // --- checkout -----------------------------------------------------------------

  /** Locks the products in a consistent order to avoid deadlocks between checkouts. */
  async lockProductsForCheckout(sql: Executor, productIds: string[]): Promise<CheckoutProductRow[]> {
    return sql<CheckoutProductRow[]>`
      select p.id, p.name, p.slug, p.sku, p.price::float8 as price, p.stock, p.status,
             (select count(*)::int from product_colors pc where pc.product_id = p.id) as color_count
      from products p
      where p.id = any(${sql.array(productIds)}::uuid[])
      order by p.id
      for update of p
    `
  },

  async findColorsForCheckout(sql: Executor, colorIds: string[]): Promise<CheckoutColorRow[]> {
    if (colorIds.length === 0) return []
    return sql<CheckoutColorRow[]>`
      select pc.id, pc.product_id, pc.name, pc.hex_value,
             (select pi.image_url from product_images pi
              where pi.product_color_id = pc.id
              order by pi.is_primary desc, pi.sort_order
              limit 1) as image_url
      from product_colors pc
      where pc.id = any(${sql.array(colorIds)}::uuid[])
    `
  },

  async decrementStock(sql: Executor, productId: string, quantity: number): Promise<void> {
    await sql`update products set stock = stock - ${quantity} where id = ${productId}`
  },

  /**
   * Finds the customer by email or creates one. An existing customer's profile
   * is never overwritten by an anonymous checkout; the order keeps its own
   * snapshot of the contact details instead.
   */
  async findOrCreateCustomer(
    sql: Executor,
    data: { email: string; fullName: string; phone: string | null },
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into customers (email, full_name, phone)
      values (${data.email}, ${data.fullName}, ${data.phone})
      on conflict ((lower(email))) do update set email = customers.email
      returning id
    `
    return row!.id
  },

  async insertAddress(
    sql: Executor,
    customerId: string,
    address: { line1: string; line2: string | null; city: string; state: string; postalCode: string; country: string },
  ): Promise<void> {
    await sql`
      insert into addresses (customer_id, line1, line2, city, state, postal_code, country, is_default)
      values (
        ${customerId}, ${address.line1}, ${address.line2}, ${address.city}, ${address.state},
        ${address.postalCode}, ${address.country},
        not exists (select 1 from addresses where customer_id = ${customerId})
      )
    `
  },

  async insertOrder(
    sql: Executor,
    data: {
      customerId: string
      customerEmail: string
      customerName: string
      customerPhone: string | null
      shipping: { line1: string; line2: string | null; city: string; state: string; postalCode: string; country: string }
      currency: string
      subtotal: number
      shippingCost: number
      total: number
    },
  ): Promise<{ id: string; orderNumber: string; createdAt: Date }> {
    const [row] = await sql<{ id: string; orderNumber: string; createdAt: Date }[]>`
      insert into orders (
        customer_id, customer_email, customer_name, customer_phone,
        shipping_line1, shipping_line2, shipping_city, shipping_state, shipping_postal_code, shipping_country,
        currency, subtotal, shipping_cost, total
      ) values (
        ${data.customerId}, ${data.customerEmail}, ${data.customerName}, ${data.customerPhone},
        ${data.shipping.line1}, ${data.shipping.line2}, ${data.shipping.city}, ${data.shipping.state},
        ${data.shipping.postalCode}, ${data.shipping.country},
        ${data.currency}, ${data.subtotal}, ${data.shippingCost}, ${data.total}
      )
      returning id, order_number, created_at
    `
    return row!
  },

  async insertItem(sql: Executor, orderId: string, item: Omit<OrderItemRecord, 'id'>): Promise<void> {
    await sql`
      insert into order_items (
        order_id, product_id, product_color_id, product_name, product_sku,
        color_name, color_hex, image_url, unit_price, quantity, line_total
      ) values (
        ${orderId}, ${item.productId}, ${item.productColorId}, ${item.productName}, ${item.productSku},
        ${item.colorName}, ${item.colorHex}, ${item.imageUrl}, ${item.unitPrice}, ${item.quantity}, ${item.lineTotal}
      )
    `
  },
}

export type OrdersRepository = typeof ordersRepository
