import type { Database } from '../../lib/db.js'
import { notFound, translateDatabaseError } from '../../lib/errors.js'
import type { PageRequest } from '../../lib/pagination.js'
import type { StorefrontRevalidator } from '../../lib/storefront-revalidate.js'
import type { CategoriesRepository } from './categories.repository.js'
import type { CreateCategoryInput, UpdateCategoryInput } from './categories.types.js'

const CONSTRAINT_MESSAGES: Record<string, string> = {
  categories_slug_key: 'A category with this slug already exists',
  // Raised on delete: products.category_id is ON DELETE RESTRICT.
  products_category_id_fkey: 'This category still has products. Move or delete them first.',
}

export class CategoriesService {
  constructor(
    private readonly db: Database,
    private readonly repository: CategoriesRepository,
    private readonly revalidator: StorefrontRevalidator,
  ) {}

  listPublic() {
    return this.repository.listActive(this.db.sql)
  }

  list(filters: { search?: string | undefined }, page: PageRequest) {
    return this.repository.list(this.db.sql, filters, page)
  }

  async getById(id: string) {
    const category = await this.repository.findById(this.db.sql, id)
    if (!category) throw notFound('Category')
    return category
  }

  async create(input: CreateCategoryInput) {
    const id = await this.repository
      .insert(this.db.sql, input)
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))
    this.revalidator.revalidateStorefront({ categories: true })
    return this.getById(id)
  }

  async update(id: string, input: UpdateCategoryInput) {
    const before = await this.repository.findById(this.db.sql, id)
    const found = await this.repository
      .update(this.db.sql, id, input)
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))
    if (!found) throw notFound('Category')

    // Category name/slug appear on product cards and detail pages.
    const renamed =
      before !== null &&
      ((input.slug !== undefined && input.slug !== before.slug) || (input.name !== undefined && input.name !== before.name))
    const productSlugs = renamed ? await this.repository.listProductSlugs(this.db.sql, id) : []
    this.revalidator.revalidateStorefront({ categories: true, productSlugs })
    return this.getById(id)
  }

  async delete(id: string) {
    const found = await this.repository
      .delete(this.db.sql, id)
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))
    if (!found) throw notFound('Category')
    this.revalidator.revalidateStorefront({ categories: true })
  }
}
