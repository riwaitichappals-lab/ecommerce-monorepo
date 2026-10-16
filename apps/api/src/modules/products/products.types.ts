export type ProductStatus = 'draft' | 'published' | 'archived'

export const PRODUCT_SORTS = [
  'updated-desc',
  'created-desc',
  'name-asc',
  'name-desc',
  'price-asc',
  'price-desc',
  'featured',
  'best-seller',
] as const
export type ProductSort = (typeof PRODUCT_SORTS)[number]

/** Database read models (camelCased rows). */

export interface ProductImageRecord {
  id: string
  imageUrl: string
  imageKitFileId: string
  alt: string | null
  sortOrder: number
  isPrimary: boolean
}

export interface ProductColorRecord {
  id: string
  name: string
  hexValue: string
  sortOrder: number
  images: ProductImageRecord[]
}

export interface CategoryRef {
  id: string
  name: string
  slug: string
}

export interface ProductRecord {
  id: string
  name: string
  slug: string
  description: string
  price: number
  compareAtPrice: number | null
  sku: string
  categoryId: string | null
  category: CategoryRef | null
  status: ProductStatus
  stock: number
  isFeatured: boolean
  isBestSeller: boolean
  publishedAt: Date | null
  createdAt: Date
  updatedAt: Date
  colors: ProductColorRecord[]
}

export interface ProductSwatch {
  id: string
  name: string
  hexValue: string
}

export interface ProductListRecord {
  id: string
  name: string
  slug: string
  sku: string
  status: ProductStatus
  price: number
  compareAtPrice: number | null
  stock: number
  isFeatured: boolean
  isBestSeller: boolean
  category: CategoryRef | null
  primaryImageUrl: string | null
  colors: ProductSwatch[]
  createdAt: Date
  updatedAt: Date
}

export interface ProductListFilters {
  search?: string | undefined
  status?: ProductStatus | undefined
  categoryId?: string | undefined
  categorySlug?: string | undefined
  featured?: boolean | undefined
  minPrice?: number | undefined
  maxPrice?: number | undefined
  /** Storefront mode: published products only. */
  publishedOnly?: boolean
  sort: ProductSort
}

/** Write models. */

export interface NewImageInput {
  imageUrl: string
  imageKitFileId: string
  alt?: string | null | undefined
  sortOrder?: number | undefined
  isPrimary?: boolean | undefined
}

export interface ExistingImageInput {
  id: string
  alt?: string | null | undefined
  sortOrder?: number | undefined
  isPrimary?: boolean | undefined
}

export interface NewColorInput {
  name: string
  hexValue: string
  sortOrder?: number | undefined
  images: NewImageInput[]
}

export interface SyncColorInput {
  id?: string | undefined
  name: string
  hexValue: string
  sortOrder?: number | undefined
  images: Array<NewImageInput | ExistingImageInput>
}

export interface CreateProductInput {
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
  colors: NewColorInput[]
}

export interface UpdateProductInput {
  name?: string | undefined
  slug?: string | undefined
  description?: string | undefined
  price?: number | undefined
  compareAtPrice?: number | null | undefined
  sku?: string | undefined
  categoryId?: string | null | undefined
  status?: ProductStatus | undefined
  stock?: number | undefined
  isFeatured?: boolean | undefined
  isBestSeller?: boolean | undefined
  /** When present, the product's colors/images are replaced by this set (see docs). */
  colors?: SyncColorInput[] | undefined
}

export interface UpdateColorInput {
  name?: string | undefined
  hexValue?: string | undefined
  sortOrder?: number | undefined
}

export interface UpdateImageInput {
  alt?: string | null | undefined
  sortOrder?: number | undefined
  isPrimary?: boolean | undefined
}
