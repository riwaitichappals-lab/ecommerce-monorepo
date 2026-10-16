import { setClause } from '../../lib/db.js'
import type { Executor } from '../../lib/db.js'
import { likePattern, pageOffset } from '../../lib/pagination.js'
import type { Page, PageRequest } from '../../lib/pagination.js'
import type {
  CategoryRecord,
  CreateCategoryInput,
  PublicCategoryRecord,
  UpdateCategoryInput,
} from './categories.types.js'

/** Storefront category lists are small; this is a safety cap, not pagination. */
const MAX_PUBLIC_CATEGORIES = 500

export const categoriesRepository = {
  async listActive(sql: Executor): Promise<PublicCategoryRecord[]> {
    return sql<PublicCategoryRecord[]>`
      select id, name, slug, description
      from categories
      where is_active
      order by sort_order, name
      limit ${MAX_PUBLIC_CATEGORIES}
    `
  },

  async list(sql: Executor, filters: { search?: string | undefined }, page: PageRequest): Promise<Page<CategoryRecord>> {
    const where = filters.search
      ? sql`(c.name ilike ${likePattern(filters.search)} or c.slug ilike ${likePattern(filters.search)})`
      : sql`true`

    const [items, [count]] = await Promise.all([
      sql<CategoryRecord[]>`
        select c.id, c.name, c.slug, c.description, c.sort_order, c.is_active, c.created_at, c.updated_at,
               (select count(*)::int from products p where p.category_id = c.id) as product_count
        from categories c
        where ${where}
        order by c.sort_order, c.name, c.id
        limit ${page.pageSize} offset ${pageOffset(page)}
      `,
      sql<{ total: number }[]>`select count(*)::int as total from categories c where ${where}`,
    ])
    return { items, total: count?.total ?? 0 }
  },

  async findById(sql: Executor, id: string): Promise<CategoryRecord | null> {
    const [row] = await sql<CategoryRecord[]>`
      select c.id, c.name, c.slug, c.description, c.sort_order, c.is_active, c.created_at, c.updated_at,
             (select count(*)::int from products p where p.category_id = c.id) as product_count
      from categories c
      where c.id = ${id}
    `
    return row ?? null
  },

  /** Slugs of the published products in a category (for storefront cache purging). */
  async listProductSlugs(sql: Executor, categoryId: string): Promise<string[]> {
    const rows = await sql<{ slug: string }[]>`
      select slug from products where category_id = ${categoryId} and status = 'published'
    `
    return rows.map((row) => row.slug)
  },

  async insert(sql: Executor, data: CreateCategoryInput): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      insert into categories (name, slug, description, sort_order, is_active)
      values (${data.name}, ${data.slug}, ${data.description}, ${data.sortOrder}, ${data.isActive})
      returning id
    `
    return row!.id
  },

  /** Returns false when the category does not exist. */
  async update(sql: Executor, id: string, data: UpdateCategoryInput): Promise<boolean> {
    const values: Record<string, unknown> = {}
    for (const key of ['name', 'slug', 'description', 'sortOrder', 'isActive'] as const) {
      if (data[key] !== undefined) values[key] = data[key]
    }
    const result = await sql`update categories set ${setClause(sql, values)} where id = ${id}`
    return result.count > 0
  },

  /** Returns false when the category does not exist. */
  async delete(sql: Executor, id: string): Promise<boolean> {
    const result = await sql`delete from categories where id = ${id}`
    return result.count > 0
  },
}

export type CategoriesRepository = typeof categoriesRepository
