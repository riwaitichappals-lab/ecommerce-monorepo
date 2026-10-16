import { z } from 'zod'
import {
  dataEnvelope,
  hexColorSchema,
  listEnvelope,
  moneySchema,
  paginationQuery,
  queryBoolean,
  searchQuery,
  slugSchema,
  uuidParam,
} from '../../schemas/common.js'
import { PRODUCT_SORTS } from './products.types.js'

/**
 * Request/response contracts for products. Documented in
 * docs/features/products/api.md; keep both in sync.
 */

export const productStatusSchema = z.enum(['draft', 'published', 'archived'])

const MAX_COLORS = 30
const MAX_IMAGES_PER_COLOR = 20

// --- params -------------------------------------------------------------------

export const productIdParams = z.object({ id: uuidParam })
export const colorParams = z.object({ id: uuidParam, colorId: uuidParam })
export const imageParams = z.object({ id: uuidParam, colorId: uuidParam, imageId: uuidParam })
export const slugParams = z.object({ slug: slugSchema })

// --- queries ------------------------------------------------------------------

export const adminProductListQuery = z.object({
  ...paginationQuery,
  search: searchQuery,
  status: productStatusSchema.optional(),
  categoryId: uuidParam.optional(),
  featured: queryBoolean.optional().describe('Only featured (true) or only non-featured (false) products'),
  sort: z.enum(PRODUCT_SORTS).default('updated-desc'),
})

export const storeProductListQuery = z
  .object({
    ...paginationQuery,
    search: searchQuery,
    category: slugSchema.optional().describe('Category slug'),
    minPrice: z.coerce.number().nonnegative().optional(),
    maxPrice: z.coerce.number().nonnegative().optional(),
    featured: queryBoolean.optional().describe('Only featured (true) or only non-featured (false) products'),
    sort: z
      .enum(['newest', 'price-asc', 'price-desc', 'name-asc', 'featured', 'best-seller'])
      .default('newest')
      .describe('featured / best-seller put flagged products first'),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must be less than or equal to maxPrice',
    path: ['minPrice'],
  })

// --- bodies -------------------------------------------------------------------

const altSchema = z.string().trim().max(250).nullable().optional()
const sortOrderSchema = z.number().int().min(0).max(10_000).optional()

export const newImageBody = z.object({
  imageUrl: z.url({ protocol: /^https$/ }).max(2048),
  imageKitFileId: z.string().trim().min(1).max(100),
  alt: altSchema,
  sortOrder: sortOrderSchema,
  isPrimary: z.boolean().optional(),
})

const existingImageBody = z.object({
  id: uuidParam,
  alt: altSchema,
  sortOrder: sortOrderSchema,
  isPrimary: z.boolean().optional(),
})

export const updateImageBody = z
  .object({ alt: altSchema, sortOrder: sortOrderSchema, isPrimary: z.boolean().optional() })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  })

const colorFields = {
  name: z.string().trim().min(1).max(50),
  hexValue: hexColorSchema,
  sortOrder: sortOrderSchema,
}

export const newColorBody = z.object({
  ...colorFields,
  images: z.array(newImageBody).max(MAX_IMAGES_PER_COLOR).default([]),
})

export const updateColorBody = z
  .object({
    name: colorFields.name.optional(),
    hexValue: hexColorSchema.optional(),
    sortOrder: sortOrderSchema,
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  })

const syncColorBody = z.object({
  id: uuidParam.optional(),
  ...colorFields,
  images: z.array(z.union([existingImageBody, newImageBody])).max(MAX_IMAGES_PER_COLOR),
})

function uniqueColorNames(colors: { name: string }[] | undefined): boolean {
  if (!colors) return true
  const names = colors.map((color) => color.name.toLowerCase())
  return new Set(names).size === names.length
}

const productFields = {
  name: z.string().trim().min(1).max(200),
  slug: slugSchema,
  description: z.string().max(10_000),
  price: moneySchema,
  compareAtPrice: moneySchema.nullable(),
  sku: z.string().trim().min(1).max(100),
  categoryId: uuidParam.nullable(),
  status: productStatusSchema,
  stock: z.number().int().min(0).max(1_000_000),
  isFeatured: z.boolean(),
  isBestSeller: z.boolean(),
}

export const createProductBody = z
  .object({
    ...productFields,
    description: productFields.description.default(''),
    compareAtPrice: productFields.compareAtPrice.default(null),
    categoryId: productFields.categoryId.default(null),
    status: productFields.status.default('draft'),
    stock: productFields.stock.default(0),
    isFeatured: productFields.isFeatured.default(false),
    isBestSeller: productFields.isBestSeller.default(false),
    colors: z.array(newColorBody).max(MAX_COLORS).default([]),
  })
  .refine((body) => body.compareAtPrice === null || body.compareAtPrice > body.price, {
    message: 'compareAtPrice must be greater than price',
    path: ['compareAtPrice'],
  })
  .refine((body) => uniqueColorNames(body.colors), { message: 'Color names must be unique', path: ['colors'] })

export const updateProductBody = z
  .object({
    name: productFields.name.optional(),
    slug: productFields.slug.optional(),
    description: productFields.description.optional(),
    price: productFields.price.optional(),
    compareAtPrice: productFields.compareAtPrice.optional(),
    sku: productFields.sku.optional(),
    categoryId: productFields.categoryId.optional(),
    status: productFields.status.optional(),
    stock: productFields.stock.optional(),
    isFeatured: productFields.isFeatured.optional(),
    isBestSeller: productFields.isBestSeller.optional(),
    colors: z
      .array(syncColorBody)
      .max(MAX_COLORS)
      .optional()
      .describe('Full replacement of the color/image set. Omit to leave colors unchanged.'),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Provide at least one field to update',
  })
  .refine((body) => uniqueColorNames(body.colors), { message: 'Color names must be unique', path: ['colors'] })

// --- responses: admin ---------------------------------------------------------

const categoryRef = z.object({ id: z.string(), name: z.string(), slug: z.string() })

export const adminImageSchema = z.object({
  id: z.string(),
  imageUrl: z.string(),
  thumbUrl: z.string(),
  imageKitFileId: z.string(),
  alt: z.string().nullable(),
  sortOrder: z.number().int(),
  isPrimary: z.boolean(),
})

export const adminColorSchema = z.object({
  id: z.string(),
  name: z.string(),
  hexValue: z.string(),
  sortOrder: z.number().int(),
  primaryImageId: z.string().nullable(),
  images: z.array(adminImageSchema),
})

export const adminProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  price: z.number(),
  compareAtPrice: z.number().nullable(),
  sku: z.string(),
  categoryId: z.string().nullable(),
  category: categoryRef.nullable(),
  status: productStatusSchema,
  stock: z.number().int(),
  isFeatured: z.boolean(),
  isBestSeller: z.boolean(),
  publishedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  colors: z.array(adminColorSchema),
})

const swatchSchema = z.object({ id: z.string(), name: z.string(), hexValue: z.string() })

export const adminProductListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  sku: z.string(),
  status: productStatusSchema,
  price: z.number(),
  compareAtPrice: z.number().nullable(),
  stock: z.number().int(),
  isFeatured: z.boolean(),
  isBestSeller: z.boolean(),
  category: categoryRef.nullable(),
  primaryImageUrl: z.string().nullable(),
  colorCount: z.number().int(),
  colors: z.array(swatchSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const adminProductResponse = dataEnvelope(adminProductSchema)
export const adminProductListResponse = listEnvelope(adminProductListItemSchema)
export const adminColorResponse = dataEnvelope(adminColorSchema)
export const adminImageResponse = dataEnvelope(adminImageSchema)

// --- responses: storefront ----------------------------------------------------
// Deliberately narrower than the admin shapes: no status, stock counts,
// ImageKit file IDs, timestamps or internal category IDs.

const publicCategoryRef = z.object({ name: z.string(), slug: z.string() })

export const storeImageSchema = z.object({
  id: z.string(),
  url: z.string(),
  thumbUrl: z.string(),
  alt: z.string().nullable(),
  sortOrder: z.number().int(),
  isPrimary: z.boolean(),
})

export const storeColorSchema = z.object({
  id: z.string(),
  name: z.string(),
  hexValue: z.string(),
  images: z.array(storeImageSchema),
})

export const storeProductSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  price: z.number(),
  compareAtPrice: z.number().nullable(),
  currency: z.string(),
  sku: z.string(),
  inStock: z.boolean(),
  isFeatured: z.boolean(),
  isBestSeller: z.boolean(),
  category: publicCategoryRef.nullable(),
  colors: z.array(storeColorSchema),
})

export const storeProductListItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  price: z.number(),
  compareAtPrice: z.number().nullable(),
  currency: z.string(),
  inStock: z.boolean(),
  isFeatured: z.boolean(),
  isBestSeller: z.boolean(),
  category: publicCategoryRef.nullable(),
  imageUrl: z.string().nullable(),
  thumbUrl: z.string().nullable(),
  colors: z.array(swatchSchema),
})

export const storeProductResponse = dataEnvelope(storeProductSchema)
export const storeProductListResponse = listEnvelope(storeProductListItemSchema)

export type CreateProductBody = z.infer<typeof createProductBody>
export type UpdateProductBody = z.infer<typeof updateProductBody>
export type AdminProductListQuery = z.infer<typeof adminProductListQuery>
export type StoreProductListQuery = z.infer<typeof storeProductListQuery>
