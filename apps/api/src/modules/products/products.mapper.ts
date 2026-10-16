import type { ProductColorRecord, ProductImageRecord, ProductListRecord, ProductRecord } from './products.types.js'

/**
 * Converts database records into API DTOs. The admin and storefront shapes
 * are intentionally different: storefront DTOs contain only public fields.
 */

export interface MapperContext {
  thumbnailUrl(url: string): string
  currency: string
}

const iso = (date: Date | null) => (date ? date.toISOString() : null)

// --- admin ----------------------------------------------------------------------

export const toAdminImage = (image: ProductImageRecord, ctx: MapperContext) => ({
  id: image.id,
  imageUrl: image.imageUrl,
  thumbUrl: ctx.thumbnailUrl(image.imageUrl),
  imageKitFileId: image.imageKitFileId,
  alt: image.alt,
  sortOrder: image.sortOrder,
  isPrimary: image.isPrimary,
})

export const toAdminColor = (color: ProductColorRecord, ctx: MapperContext) => ({
  id: color.id,
  name: color.name,
  hexValue: color.hexValue,
  sortOrder: color.sortOrder,
  primaryImageId: color.images.find((image) => image.isPrimary)?.id ?? null,
  images: color.images.map((image) => toAdminImage(image, ctx)),
})

export const toAdminProduct = (product: ProductRecord, ctx: MapperContext) => ({
  id: product.id,
  name: product.name,
  slug: product.slug,
  description: product.description,
  price: product.price,
  compareAtPrice: product.compareAtPrice,
  sku: product.sku,
  categoryId: product.categoryId,
  category: product.category,
  status: product.status,
  stock: product.stock,
  isFeatured: product.isFeatured,
  isBestSeller: product.isBestSeller,
  publishedAt: iso(product.publishedAt),
  createdAt: product.createdAt.toISOString(),
  updatedAt: product.updatedAt.toISOString(),
  colors: product.colors.map((color) => toAdminColor(color, ctx)),
})

export const toAdminProductListItem = (product: ProductListRecord) => ({
  id: product.id,
  name: product.name,
  slug: product.slug,
  sku: product.sku,
  status: product.status,
  price: product.price,
  compareAtPrice: product.compareAtPrice,
  stock: product.stock,
  isFeatured: product.isFeatured,
  isBestSeller: product.isBestSeller,
  category: product.category,
  primaryImageUrl: product.primaryImageUrl,
  colorCount: product.colors.length,
  colors: product.colors,
  createdAt: product.createdAt.toISOString(),
  updatedAt: product.updatedAt.toISOString(),
})

// --- storefront -----------------------------------------------------------------

const publicCategory = (category: ProductRecord['category']) =>
  category ? { name: category.name, slug: category.slug } : null

export const toStoreProduct = (product: ProductRecord, ctx: MapperContext) => ({
  id: product.id,
  slug: product.slug,
  name: product.name,
  description: product.description,
  price: product.price,
  compareAtPrice: product.compareAtPrice,
  currency: ctx.currency,
  sku: product.sku,
  inStock: product.stock > 0,
  isFeatured: product.isFeatured,
  isBestSeller: product.isBestSeller,
  category: publicCategory(product.category),
  colors: product.colors
    // A published product always has images per color (enforced), but never
    // render an empty color on the storefront if legacy data slips through.
    .filter((color) => color.images.length > 0)
    .map((color) => ({
      id: color.id,
      name: color.name,
      hexValue: color.hexValue,
      images: color.images.map((image) => ({
        id: image.id,
        url: image.imageUrl,
        thumbUrl: ctx.thumbnailUrl(image.imageUrl),
        alt: image.alt,
        sortOrder: image.sortOrder,
        isPrimary: image.isPrimary,
      })),
    })),
})

export const toStoreProductListItem = (product: ProductListRecord, ctx: MapperContext) => ({
  id: product.id,
  slug: product.slug,
  name: product.name,
  price: product.price,
  compareAtPrice: product.compareAtPrice,
  currency: ctx.currency,
  inStock: product.stock > 0,
  isFeatured: product.isFeatured,
  isBestSeller: product.isBestSeller,
  category: publicCategory(product.category),
  imageUrl: product.primaryImageUrl,
  thumbUrl: product.primaryImageUrl ? ctx.thumbnailUrl(product.primaryImageUrl) : null,
  colors: product.colors,
})
