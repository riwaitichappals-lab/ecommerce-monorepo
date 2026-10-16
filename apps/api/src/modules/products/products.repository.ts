import { setClause } from '../../lib/db.js'
import type { Executor, Fragment } from '../../lib/db.js'
import { likePattern, pageOffset } from '../../lib/pagination.js'
import type { Page, PageRequest } from '../../lib/pagination.js'
import type {
  ProductListFilters,
  ProductListRecord,
  ProductRecord,
  ProductSort,
  ProductStatus,
  UpdateColorInput,
  UpdateImageInput,
} from './products.types.js'

/**
 * All SQL for products, colors and images. Every function takes an Executor
 * (pool or transaction) as its first argument; transactions are owned by the
 * service layer.
 */

function productDetailQuery(sql: Executor, where: Fragment) {
  // One round trip: product + category + colors[] + images[] as nested JSON.
  // This is what makes storefront color switching free of extra requests.
  return sql<ProductRecord[]>`
    select
      p.id, p.name, p.slug, p.description,
      p.price::float8 as price,
      p.compare_at_price::float8 as compare_at_price,
      p.sku, p.category_id, p.status, p.stock, p.is_featured, p.is_best_seller,
      p.published_at, p.created_at, p.updated_at,
      case when c.id is null then null
           else json_build_object('id', c.id, 'name', c.name, 'slug', c.slug) end as category,
      coalesce((
        select json_agg(json_build_object(
                 'id', pc.id,
                 'name', pc.name,
                 'hexValue', pc.hex_value,
                 'sortOrder', pc.sort_order,
                 'images', coalesce((
                   select json_agg(json_build_object(
                            'id', pi.id,
                            'imageUrl', pi.image_url,
                            'imageKitFileId', pi.imagekit_file_id,
                            'alt', pi.alt,
                            'sortOrder', pi.sort_order,
                            'isPrimary', pi.is_primary
                          ) order by pi.sort_order, pi.created_at)
                   from product_images pi
                   where pi.product_color_id = pc.id
                 ), '[]'::json)
               ) order by pc.sort_order, pc.created_at)
        from product_colors pc
        where pc.product_id = p.id
      ), '[]'::json) as colors
    from products p
    left join categories c on c.id = p.category_id
    where ${where}
  `
}

function orderBy(sql: Executor, sort: ProductSort) {
  switch (sort) {
    case 'name-asc':
      return sql`p.name asc, p.id`
    case 'name-desc':
      return sql`p.name desc, p.id`
    case 'price-asc':
      return sql`p.price asc, p.id`
    case 'price-desc':
      return sql`p.price desc, p.id`
    case 'created-desc':
      return sql`p.created_at desc, p.id`
    case 'updated-desc':
      return sql`p.updated_at desc, p.id`
    case 'featured':
      return sql`p.is_featured desc, p.created_at desc, p.id`
    case 'best-seller':
      return sql`p.is_best_seller desc, p.created_at desc, p.id`
  }
}

function listConditions(sql: Executor, filters: ProductListFilters) {
  const conditions = [sql`true`]
  if (filters.publishedOnly) conditions.push(sql`p.status = 'published'`)
  if (filters.status) conditions.push(sql`p.status = ${filters.status}`)
  if (filters.categoryId) conditions.push(sql`p.category_id = ${filters.categoryId}`)
  if (filters.featured !== undefined) conditions.push(sql`p.is_featured = ${filters.featured}`)
  if (filters.categorySlug) conditions.push(sql`c.slug = ${filters.categorySlug} and c.is_active`)
  if (filters.minPrice !== undefined) conditions.push(sql`p.price >= ${filters.minPrice}`)
  if (filters.maxPrice !== undefined) conditions.push(sql`p.price <= ${filters.maxPrice}`)
  if (filters.search) {
    const pattern = likePattern(filters.search)
    conditions.push(sql`(p.name ilike ${pattern} or p.sku ilike ${pattern})`)
  }
  return conditions.reduce((acc, condition) => sql`${acc} and ${condition}`)
}

export const productsRepository = {
  async findById(sql: Executor, id: string): Promise<ProductRecord | null> {
    const [row] = await productDetailQuery(sql, sql`p.id = ${id}`)
    return row ?? null
  },

  async findPublishedBySlug(sql: Executor, slug: string): Promise<ProductRecord | null> {
    const [row] = await productDetailQuery(sql, sql`p.slug = ${slug} and p.status = 'published'`)
    return row ?? null
  },

  async list(sql: Executor, filters: ProductListFilters, page: PageRequest): Promise<Page<ProductListRecord>> {
    const where = listConditions(sql, filters)

    const [items, [countRow]] = await Promise.all([
      sql<ProductListRecord[]>`
        select
          p.id, p.name, p.slug, p.sku, p.status,
          p.price::float8 as price,
          p.compare_at_price::float8 as compare_at_price,
          p.stock, p.is_featured, p.is_best_seller, p.created_at, p.updated_at,
          case when c.id is null then null
               else json_build_object('id', c.id, 'name', c.name, 'slug', c.slug) end as category,
          (
            select pi.image_url
            from product_colors pc
            join product_images pi on pi.product_color_id = pc.id
            where pc.product_id = p.id
            order by pc.sort_order, pi.is_primary desc, pi.sort_order
            limit 1
          ) as primary_image_url,
          coalesce((
            select json_agg(json_build_object('id', pc.id, 'name', pc.name, 'hexValue', pc.hex_value)
                            order by pc.sort_order, pc.created_at)
            from product_colors pc
            where pc.product_id = p.id
          ), '[]'::json) as colors
        from products p
        left join categories c on c.id = p.category_id
        where ${where}
        order by ${orderBy(sql, filters.sort)}
        limit ${page.pageSize} offset ${pageOffset(page)}
      `,
      sql<{ total: number }[]>`
        select count(*)::int as total
        from products p
        left join categories c on c.id = p.category_id
        where ${where}
      `,
    ])

    return { items, total: countRow?.total ?? 0 }
  },

  /** Locks the product row for the rest of the transaction. */
  async lockProduct(
    sql: Executor,
    id: string,
  ): Promise<{ id: string; slug: string; status: ProductStatus; price: number; compareAtPrice: number | null; publishedAt: Date | null } | null> {
    const [row] = await sql<
      { id: string; slug: string; status: ProductStatus; price: number; compareAtPrice: number | null; publishedAt: Date | null }[]
    >`
      select id, slug, status, price::float8 as price, compare_at_price::float8 as compare_at_price, published_at
      from products
      where id = ${id}
      for update
    `
    return row ?? null
  },

  async categoryExists(sql: Executor, categoryId: string): Promise<boolean> {
    const [row] = await sql`select 1 from categories where id = ${categoryId}`
    return Boolean(row)
  },

  async insertProduct(
    sql: Executor,
    data: {
      name: string
      slug: string
      description: string
      price: number
      compareAtPrice: number | null
      sku: string
      categoryId: string | null
      status: ProductStatus
      stock: number
      isFeatured: boolean
      isBestSeller: boolean
    },
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into products (name, slug, description, price, compare_at_price, sku, category_id, status, stock, is_featured, is_best_seller, published_at)
      values (
        ${data.name}, ${data.slug}, ${data.description}, ${data.price}, ${data.compareAtPrice},
        ${data.sku}, ${data.categoryId}, ${data.status}, ${data.stock}, ${data.isFeatured}, ${data.isBestSeller},
        ${data.status === 'published' ? sql`now()` : null}
      )
      returning id
    `
    return row!.id
  },

  async updateProduct(sql: Executor, id: string, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) {
      // Still bump updated_at so caches keyed on it are invalidated.
      await sql`update products set updated_at = now() where id = ${id}`
      return
    }
    await sql`update products set ${setClause(sql, patch)} where id = ${id}`
  },

  async markPublished(sql: Executor, id: string): Promise<void> {
    await sql`update products set published_at = coalesce(published_at, now()) where id = ${id}`
  },

  async listImageFileIdsForProduct(sql: Executor, productId: string): Promise<string[]> {
    const rows = await sql<{ imagekitFileId: string }[]>`
      select pi.imagekit_file_id
      from product_images pi
      join product_colors pc on pc.id = pi.product_color_id
      where pc.product_id = ${productId}
    `
    return rows.map((row) => row.imagekitFileId)
  },

  async deleteProduct(sql: Executor, id: string): Promise<void> {
    await sql`delete from products where id = ${id}`
  },

  // --- colors ---------------------------------------------------------------

  async findColor(sql: Executor, productId: string, colorId: string): Promise<{ id: string } | null> {
    const [row] = await sql<{ id: string }[]>`
      select id from product_colors where id = ${colorId} and product_id = ${productId}
    `
    return row ?? null
  },

  async nextColorSortOrder(sql: Executor, productId: string): Promise<number> {
    const [row] = await sql<{ next: number }[]>`
      select coalesce(max(sort_order) + 1, 0)::int as next from product_colors where product_id = ${productId}
    `
    return row?.next ?? 0
  },

  async insertColor(
    sql: Executor,
    productId: string,
    data: { name: string; hexValue: string; sortOrder: number },
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into product_colors (product_id, name, hex_value, sort_order)
      values (${productId}, ${data.name}, ${data.hexValue}, ${data.sortOrder})
      returning id
    `
    return row!.id
  },

  async updateColor(sql: Executor, colorId: string, patch: UpdateColorInput): Promise<void> {
    const values: Record<string, unknown> = {}
    if (patch.name !== undefined) values.name = patch.name
    if (patch.hexValue !== undefined) values.hexValue = patch.hexValue
    if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder
    if (Object.keys(values).length === 0) return
    await sql`update product_colors set ${setClause(sql, values)} where id = ${colorId}`
  },

  async listImageFileIdsForColor(sql: Executor, colorId: string): Promise<string[]> {
    const rows = await sql<{ imagekitFileId: string }[]>`
      select imagekit_file_id from product_images where product_color_id = ${colorId}
    `
    return rows.map((row) => row.imagekitFileId)
  },

  async deleteColor(sql: Executor, colorId: string): Promise<void> {
    await sql`delete from product_colors where id = ${colorId}`
  },

  /** Per-color image counts, used to enforce the publish rule. */
  async colorImageCounts(sql: Executor, productId: string): Promise<{ colorId: string; imageCount: number }[]> {
    return sql<{ colorId: string; imageCount: number }[]>`
      select pc.id as color_id, count(pi.id)::int as image_count
      from product_colors pc
      left join product_images pi on pi.product_color_id = pc.id
      where pc.product_id = ${productId}
      group by pc.id
    `
  },

  /** Colors and their image ids for a product (used by the colors sync). */
  async colorImageMap(
    sql: Executor,
    productId: string,
  ): Promise<{ colorId: string; images: { id: string; imageKitFileId: string }[] }[]> {
    return sql<{ colorId: string; images: { id: string; imageKitFileId: string }[] }[]>`
      select pc.id as color_id,
             coalesce(json_agg(json_build_object('id', pi.id, 'imageKitFileId', pi.imagekit_file_id))
                      filter (where pi.id is not null), '[]'::json) as images
      from product_colors pc
      left join product_images pi on pi.product_color_id = pc.id
      where pc.product_id = ${productId}
      group by pc.id
    `
  },

  // --- images ---------------------------------------------------------------

  async findImage(
    sql: Executor,
    colorId: string,
    imageId: string,
  ): Promise<{ id: string; isPrimary: boolean; imageKitFileId: string } | null> {
    const [row] = await sql<{ id: string; isPrimary: boolean; imageKitFileId: string }[]>`
      select id, is_primary, imagekit_file_id as image_kit_file_id
      from product_images
      where id = ${imageId} and product_color_id = ${colorId}
    `
    return row ?? null
  },

  async countImages(sql: Executor, colorId: string): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from product_images where product_color_id = ${colorId}
    `
    return row?.count ?? 0
  },

  async nextImageSortOrder(sql: Executor, colorId: string): Promise<number> {
    const [row] = await sql<{ next: number }[]>`
      select coalesce(max(sort_order) + 1, 0)::int as next from product_images where product_color_id = ${colorId}
    `
    return row?.next ?? 0
  },

  async insertImage(
    sql: Executor,
    colorId: string,
    data: { imageUrl: string; imageKitFileId: string; alt: string | null; sortOrder: number; isPrimary: boolean },
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into product_images (product_color_id, image_url, imagekit_file_id, alt, sort_order, is_primary)
      values (${colorId}, ${data.imageUrl}, ${data.imageKitFileId}, ${data.alt}, ${data.sortOrder}, ${data.isPrimary})
      returning id
    `
    return row!.id
  },

  async updateImage(sql: Executor, imageId: string, patch: UpdateImageInput): Promise<void> {
    const values: Record<string, unknown> = {}
    if (patch.alt !== undefined) values.alt = patch.alt
    if (patch.sortOrder !== undefined) values.sortOrder = patch.sortOrder
    if (patch.isPrimary !== undefined) values.isPrimary = patch.isPrimary
    if (Object.keys(values).length === 0) return
    await sql`update product_images set ${setClause(sql, values)} where id = ${imageId}`
  },

  async clearPrimary(sql: Executor, colorId: string): Promise<void> {
    await sql`update product_images set is_primary = false where product_color_id = ${colorId} and is_primary`
  },

  async setPrimary(sql: Executor, colorId: string, imageId: string): Promise<void> {
    await sql`update product_images set is_primary = false where product_color_id = ${colorId} and is_primary and id <> ${imageId}`
    await sql`update product_images set is_primary = true where id = ${imageId}`
  },

  /** Ensures a color with images has exactly one primary (the first by sort order if none). */
  async ensurePrimary(sql: Executor, colorId: string): Promise<void> {
    await sql`
      update product_images set is_primary = true
      where id = (
        select id from product_images
        where product_color_id = ${colorId}
        order by sort_order, created_at
        limit 1
      )
      and not exists (select 1 from product_images where product_color_id = ${colorId} and is_primary)
    `
  },

  async deleteImage(sql: Executor, imageId: string): Promise<void> {
    await sql`delete from product_images where id = ${imageId}`
  },

  async findImageById(sql: Executor, imageId: string) {
    const [row] = await sql<
      { id: string; imageUrl: string; imageKitFileId: string; alt: string | null; sortOrder: number; isPrimary: boolean }[]
    >`
      select id, image_url, imagekit_file_id as image_kit_file_id, alt, sort_order, is_primary
      from product_images
      where id = ${imageId}
    `
    return row ?? null
  },
}

export type ProductsRepository = typeof productsRepository
