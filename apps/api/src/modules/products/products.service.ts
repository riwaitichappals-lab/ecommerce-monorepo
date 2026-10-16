import type { Database, Executor } from '../../lib/db.js'
import { businessRule, notFound, translateDatabaseError } from '../../lib/errors.js'
import type { Page, PageRequest } from '../../lib/pagination.js'
import type { StorefrontRevalidator } from '../../lib/storefront-revalidate.js'
import type { AssetCleanupService } from '../uploads/asset-cleanup.service.js'
import type { UploadsService } from '../uploads/uploads.service.js'
import type { ProductsRepository } from './products.repository.js'
import type {
  CreateProductInput,
  ExistingImageInput,
  NewColorInput,
  NewImageInput,
  ProductColorRecord,
  ProductImageRecord,
  ProductListFilters,
  ProductListRecord,
  ProductRecord,
  SyncColorInput,
  UpdateColorInput,
  UpdateImageInput,
  UpdateProductInput,
} from './products.types.js'

/** Maps unique/check constraint names to client-facing messages. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  products_slug_key: 'A product with this slug already exists',
  products_sku_key: 'A product with this SKU already exists',
  product_colors_product_name_key: 'This product already has a color with that name',
  product_images_imagekit_file_id_key: 'This ImageKit file is already attached to a product image',
  products_category_id_fkey: 'Category does not exist',
}

const isExistingImage = (image: NewImageInput | ExistingImageInput): image is ExistingImageInput => 'id' in image

/** Index of the image to mark primary: the first flagged one, else the first. */
function primaryIndex(images: Array<{ isPrimary?: boolean | undefined }>): number {
  const flagged = images.findIndex((image) => image.isPrimary === true)
  return flagged === -1 ? 0 : flagged
}

/**
 * Product, color and image business logic.
 *
 * Business rules (docs/features/products/README.md#business-rules):
 *  - A published product has at least one color, and every color has at
 *    least one image. Checked on publish and on every change that could break it.
 *  - Each color with images has exactly one primary image.
 *  - Multi-row changes run in one transaction with the product row locked.
 *  - Deleting images removes DB rows first, then ImageKit assets (via the
 *    asset cleanup queue).
 */
export class ProductsService {
  constructor(
    private readonly db: Database,
    private readonly repository: ProductsRepository,
    private readonly uploads: UploadsService,
    private readonly assets: AssetCleanupService,
    private readonly revalidator: StorefrontRevalidator,
  ) {}

  // --- reads ------------------------------------------------------------------

  list(filters: ProductListFilters, page: PageRequest): Promise<Page<ProductListRecord>> {
    return this.repository.list(this.db.sql, filters, page)
  }

  async getById(id: string): Promise<ProductRecord> {
    const product = await this.repository.findById(this.db.sql, id)
    if (!product) throw notFound('Product')
    return product
  }

  async getPublishedBySlug(slug: string): Promise<ProductRecord> {
    const product = await this.repository.findPublishedBySlug(this.db.sql, slug)
    if (!product) throw notFound('Product')
    return product
  }

  // --- products -----------------------------------------------------------------

  async create(input: CreateProductInput): Promise<ProductRecord> {
    if (input.status === 'published') this.assertPublishableInput(input.colors)

    const colors = await this.validateNewColors(input.colors)

    const id = await this.db
      .transaction(async (tx) => {
        if (input.categoryId) await this.assertCategoryExists(tx, input.categoryId)
        const productId = await this.repository.insertProduct(tx, {
          name: input.name,
          slug: input.slug,
          description: input.description,
          price: input.price,
          compareAtPrice: input.compareAtPrice,
          sku: input.sku,
          categoryId: input.categoryId,
          status: input.status,
          stock: input.stock,
          isFeatured: input.isFeatured,
          isBestSeller: input.isBestSeller,
        })
        for (const [index, color] of colors.entries()) {
          await this.insertColorWithImages(tx, productId, color, color.sortOrder ?? index)
        }
        return productId
      })
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))

    this.revalidator.revalidateStorefront({ productSlugs: [input.slug] })
    return this.getById(id)
  }

  async update(id: string, input: UpdateProductInput): Promise<ProductRecord> {
    // Validate new images with ImageKit before opening the transaction, so no
    // row locks are held during network calls.
    const newImages = (input.colors ?? []).flatMap((color) => color.images.filter((image) => !isExistingImage(image)))
    const validated = new Map(
      (await this.uploads.validateImages(newImages as NewImageInput[])).map((image) => [image.imageKitFileId, image]),
    )

    const { removedFileIds, previousSlug } = await this.db
      .transaction(async (tx) => {
        const current = await this.repository.lockProduct(tx, id)
        if (!current) throw notFound('Product')

        const price = input.price ?? current.price
        const compareAtPrice = input.compareAtPrice !== undefined ? input.compareAtPrice : current.compareAtPrice
        if (compareAtPrice !== null && compareAtPrice <= price) {
          throw businessRule('compareAtPrice must be greater than price', { field: 'compareAtPrice' })
        }
        if (input.categoryId) await this.assertCategoryExists(tx, input.categoryId)

        const patch: Record<string, unknown> = {}
        for (const key of ['name', 'slug', 'description', 'price', 'compareAtPrice', 'sku', 'categoryId', 'status', 'stock', 'isFeatured', 'isBestSeller'] as const) {
          if (input[key] !== undefined) patch[key] = input[key]
        }
        await this.repository.updateProduct(tx, id, patch)

        const removed = input.colors ? await this.syncColors(tx, id, input.colors, validated) : []

        const nextStatus = input.status ?? current.status
        if (nextStatus === 'published') {
          await this.assertPublishable(tx, id)
          if (!current.publishedAt) await this.repository.markPublished(tx, id)
        }

        await this.assets.enqueue(tx, removed)
        return { removedFileIds: removed, previousSlug: current.slug }
      })
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))

    // Old and new slug: a renamed product's old page must be purged too.
    this.revalidator.revalidateStorefront({
      productSlugs: [previousSlug, input.slug ?? previousSlug],
      categories: input.categoryId !== undefined,
    })
    await this.assets.deleteNow(removedFileIds)
    return this.getById(id)
  }

  async delete(id: string): Promise<void> {
    const { fileIds, slug } = await this.db.transaction(async (tx) => {
      const product = await this.repository.lockProduct(tx, id)
      if (!product) throw notFound('Product')
      const ids = await this.repository.listImageFileIdsForProduct(tx, id)
      // Colors and images cascade. Order items keep their snapshot and the
      // product_id link becomes null.
      await this.repository.deleteProduct(tx, id)
      await this.assets.enqueue(tx, ids)
      return { fileIds: ids, slug: product.slug }
    })
    this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    await this.assets.deleteNow(fileIds)
  }

  // --- colors -------------------------------------------------------------------

  async addColor(productId: string, input: NewColorInput): Promise<ProductColorRecord> {
    const [color] = await this.validateNewColors([input])

    const { colorId, slug } = await this.db
      .transaction(async (tx) => {
        const product = await this.repository.lockProduct(tx, productId)
        if (!product) throw notFound('Product')
        if (product.status === 'published' && color!.images.length === 0) {
          throw businessRule('Colors added to a published product must include at least one image')
        }
        const sortOrder = color!.sortOrder ?? (await this.repository.nextColorSortOrder(tx, productId))
        const id = await this.insertColorWithImages(tx, productId, color!, sortOrder)
        await this.repository.updateProduct(tx, productId, {})
        return { colorId: id, slug: product.slug }
      })
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))

    this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    return this.loadColor(productId, colorId)
  }

  async updateColor(productId: string, colorId: string, input: UpdateColorInput): Promise<ProductColorRecord> {
    const slug = await this.db
      .transaction(async (tx) => {
        const product = await this.lockProductAndColor(tx, productId, colorId)
        await this.repository.updateColor(tx, colorId, input)
        await this.repository.updateProduct(tx, productId, {})
        return product.slug
      })
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))

    this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    return this.loadColor(productId, colorId)
  }

  async deleteColor(productId: string, colorId: string): Promise<void> {
    const { fileIds, slug } = await this.db.transaction(async (tx) => {
      const product = await this.lockProductAndColor(tx, productId, colorId)
      if (product.status === 'published') {
        const colors = await this.repository.colorImageCounts(tx, productId)
        if (colors.length <= 1) {
          throw businessRule('A published product must keep at least one color. Unpublish it first.')
        }
      }
      const ids = await this.repository.listImageFileIdsForColor(tx, colorId)
      await this.repository.deleteColor(tx, colorId)
      await this.repository.updateProduct(tx, productId, {})
      await this.assets.enqueue(tx, ids)
      return { fileIds: ids, slug: product.slug }
    })
    this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    await this.assets.deleteNow(fileIds)
  }

  // --- images -------------------------------------------------------------------

  async addImage(productId: string, colorId: string, input: NewImageInput): Promise<ProductImageRecord> {
    const [image] = await this.uploads.validateImages([input])

    const { imageId, slug } = await this.db
      .transaction(async (tx) => {
        const product = await this.lockProductAndColor(tx, productId, colorId)
        const existingCount = await this.repository.countImages(tx, colorId)
        const isPrimary = image!.isPrimary === true || existingCount === 0
        if (isPrimary) await this.repository.clearPrimary(tx, colorId)
        const id = await this.repository.insertImage(tx, colorId, {
          imageUrl: image!.imageUrl,
          imageKitFileId: image!.imageKitFileId,
          alt: image!.alt ?? null,
          sortOrder: image!.sortOrder ?? (await this.repository.nextImageSortOrder(tx, colorId)),
          isPrimary,
        })
        await this.repository.updateProduct(tx, productId, {})
        return { imageId: id, slug: product.slug }
      })
      .catch((error) => translateDatabaseError(error, CONSTRAINT_MESSAGES))

    this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    return this.loadImage(imageId)
  }

  async updateImage(productId: string, colorId: string, imageId: string, input: UpdateImageInput): Promise<ProductImageRecord> {
    const slug = await this.db.transaction(async (tx) => {
      const product = await this.lockProductAndColor(tx, productId, colorId)
      const image = await this.repository.findImage(tx, colorId, imageId)
      if (!image) throw notFound('Image')

      await this.repository.updateImage(tx, imageId, { alt: input.alt, sortOrder: input.sortOrder })
      if (input.isPrimary === true) {
        await this.repository.setPrimary(tx, colorId, imageId)
      } else if (input.isPrimary === false && image.isPrimary) {
        await this.repository.updateImage(tx, imageId, { isPrimary: false })
        await this.repository.ensurePrimary(tx, colorId)
      }
      await this.repository.updateProduct(tx, productId, {})
      return product.slug
    })
    this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    return this.loadImage(imageId)
  }

  /**
   * Idempotent: deleting an image that is already gone succeeds (204), as long
   * as the product and color exist.
   */
  async deleteImage(productId: string, colorId: string, imageId: string): Promise<void> {
    const { fileIds, slug } = await this.db.transaction(async (tx) => {
      const product = await this.lockProductAndColor(tx, productId, colorId)
      const image = await this.repository.findImage(tx, colorId, imageId)
      if (!image) return { fileIds: [] as string[], slug: null as string | null }

      if (product.status === 'published' && (await this.repository.countImages(tx, colorId)) <= 1) {
        throw businessRule(
          'Every color of a published product needs at least one image. Add another image first, or unpublish the product.',
        )
      }

      await this.repository.deleteImage(tx, imageId)
      if (image.isPrimary) await this.repository.ensurePrimary(tx, colorId)
      await this.repository.updateProduct(tx, productId, {})
      await this.assets.enqueue(tx, [image.imageKitFileId])
      return { fileIds: [image.imageKitFileId], slug: product.slug as string | null }
    })
    // Already-gone image: nothing changed, nothing to purge.
    if (slug) this.revalidator.revalidateStorefront({ productSlugs: [slug] })
    await this.assets.deleteNow(fileIds)
  }

  // --- internals ----------------------------------------------------------------

  private async validateNewColors(colors: NewColorInput[]): Promise<NewColorInput[]> {
    const images = await this.uploads.validateImages(colors.flatMap((color) => color.images))
    const byFileId = new Map(images.map((image) => [image.imageKitFileId, image]))
    return colors.map((color) => ({
      ...color,
      images: color.images.map((image) => byFileId.get(image.imageKitFileId) ?? image),
    }))
  }

  private async insertColorWithImages(tx: Executor, productId: string, color: NewColorInput, sortOrder: number): Promise<string> {
    const colorId = await this.repository.insertColor(tx, productId, {
      name: color.name,
      hexValue: color.hexValue,
      sortOrder,
    })
    const primary = primaryIndex(color.images)
    for (const [index, image] of color.images.entries()) {
      await this.repository.insertImage(tx, colorId, {
        imageUrl: image.imageUrl,
        imageKitFileId: image.imageKitFileId,
        alt: image.alt ?? null,
        sortOrder: image.sortOrder ?? index,
        isPrimary: index === primary,
      })
    }
    return colorId
  }

  /**
   * Replaces the product's colors/images with `colors`:
   *  - colors/images with an `id` are updated (and must belong to this product)
   *  - colors/images without an `id` are created
   *  - existing colors/images not present are deleted
   * Returns the ImageKit file IDs of deleted images.
   */
  private async syncColors(
    tx: Executor,
    productId: string,
    colors: SyncColorInput[],
    validatedImages: Map<string, NewImageInput>,
  ): Promise<string[]> {
    const existing = await this.repository.colorImageMap(tx, productId)
    const existingById = new Map(existing.map((color) => [color.colorId, color]))
    const keptColorIds = new Set(colors.flatMap((color) => (color.id ? [color.id] : [])))
    const removedFileIds: string[] = []

    for (const color of colors) {
      if (color.id && !existingById.has(color.id)) {
        throw businessRule('A color in the request does not belong to this product', { colorId: color.id })
      }
    }

    // Remove dropped colors first so their names are free for reuse.
    for (const color of existing) {
      if (!keptColorIds.has(color.colorId)) {
        removedFileIds.push(...color.images.map((image) => image.imageKitFileId))
        await this.repository.deleteColor(tx, color.colorId)
      }
    }

    for (const [index, color] of colors.entries()) {
      const sortOrder = color.sortOrder ?? index
      let colorId: string
      if (color.id) {
        colorId = color.id
        await this.repository.updateColor(tx, colorId, { name: color.name, hexValue: color.hexValue, sortOrder })
      } else {
        colorId = await this.repository.insertColor(tx, productId, { name: color.name, hexValue: color.hexValue, sortOrder })
      }

      const currentImages = color.id ? existingById.get(color.id)!.images : []
      const currentImageIds = new Set(currentImages.map((image) => image.id))
      const keptImageIds = new Set<string>()
      for (const image of color.images) {
        if (!isExistingImage(image)) continue
        if (!currentImageIds.has(image.id)) {
          throw businessRule('An image in the request does not belong to this color', { imageId: image.id, colorId })
        }
        keptImageIds.add(image.id)
      }

      for (const image of currentImages) {
        if (!keptImageIds.has(image.id)) {
          removedFileIds.push(image.imageKitFileId)
          await this.repository.deleteImage(tx, image.id)
        }
      }

      await this.repository.clearPrimary(tx, colorId)
      const primary = primaryIndex(color.images)
      for (const [imageIndex, image] of color.images.entries()) {
        const imageSortOrder = image.sortOrder ?? imageIndex
        if (isExistingImage(image)) {
          await this.repository.updateImage(tx, image.id, {
            alt: image.alt,
            sortOrder: imageSortOrder,
            isPrimary: imageIndex === primary,
          })
        } else {
          const verified = validatedImages.get(image.imageKitFileId) ?? image
          await this.repository.insertImage(tx, colorId, {
            imageUrl: verified.imageUrl,
            imageKitFileId: verified.imageKitFileId,
            alt: image.alt ?? null,
            sortOrder: imageSortOrder,
            isPrimary: imageIndex === primary,
          })
        }
      }
    }

    return removedFileIds
  }

  private async lockProductAndColor(tx: Executor, productId: string, colorId: string) {
    const product = await this.repository.lockProduct(tx, productId)
    if (!product) throw notFound('Product')
    if (!(await this.repository.findColor(tx, productId, colorId))) throw notFound('Color')
    return product
  }

  private async assertCategoryExists(tx: Executor, categoryId: string): Promise<void> {
    if (!(await this.repository.categoryExists(tx, categoryId))) {
      throw businessRule('Category does not exist', { field: 'categoryId' })
    }
  }

  private assertPublishableInput(colors: NewColorInput[]): void {
    if (colors.length === 0) throw businessRule('A published product needs at least one color')
    if (colors.some((color) => color.images.length === 0)) {
      throw businessRule('Every color needs at least one image before the product can be published')
    }
  }

  private async assertPublishable(tx: Executor, productId: string): Promise<void> {
    const colors = await this.repository.colorImageCounts(tx, productId)
    if (colors.length === 0) throw businessRule('A published product needs at least one color')
    const empty = colors.filter((color) => color.imageCount === 0).map((color) => color.colorId)
    if (empty.length > 0) {
      throw businessRule('Every color needs at least one image before the product can be published', {
        colorIds: empty,
      })
    }
  }

  private async loadColor(productId: string, colorId: string): Promise<ProductColorRecord> {
    const product = await this.getById(productId)
    const color = product.colors.find((candidate) => candidate.id === colorId)
    if (!color) throw notFound('Color')
    return color
  }

  private async loadImage(imageId: string): Promise<ProductImageRecord> {
    const image = await this.repository.findImageById(this.db.sql, imageId)
    if (!image) throw notFound('Image')
    return image
  }
}
