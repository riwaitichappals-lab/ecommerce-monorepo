/**
 * Shared API contract types.
 *
 * These mirror the JSON returned by the e-commerce API server
 * (see e-commerce-api-server/docs/features/<feature>/api.md). The admin
 * dashboard never talks to Supabase for data (only for auth), so this file is
 * the single source of truth for what "the API" means to the frontend.
 *
 * The API client unwraps the `{ data }` envelope, so these are the inner
 * shapes. Lists are returned as `Paginated<T>` (`{ items, pagination }`).
 */

export interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface Paginated<T> {
  items: T[]
  pagination: Pagination
}

// ---------------------------------------------------------------------------
// Auth / admin users
// ---------------------------------------------------------------------------

export type AdminRole = 'owner' | 'admin' | 'staff'

export interface AdminProfile {
  id: string
  email: string
  fullName: string
  role: AdminRole
  avatarUrl: string | null
  createdAt: string
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export interface CategoryRef {
  id: string
  name: string
  slug: string
}

export interface Category extends CategoryRef {
  description: string
  sortOrder: number
  isActive: boolean
  productCount: number
  createdAt: string
  updatedAt: string
}

export interface CategoryInput {
  name: string
  slug: string
  description: string
  sortOrder: number
  isActive: boolean
}

export interface CategoryListParams {
  page?: number
  pageSize?: number
  search?: string
}

// ---------------------------------------------------------------------------
// Products, colors, images
// ---------------------------------------------------------------------------

export type ProductStatus = 'draft' | 'published' | 'archived'

export interface ProductImage {
  id: string
  imageUrl: string
  thumbUrl: string
  imageKitFileId: string
  alt: string | null
  sortOrder: number
  isPrimary: boolean
}

/**
 * A color variant. Images are embedded so the storefront can switch colors
 * without extra requests.
 */
export interface ProductColor {
  id: string
  name: string
  hexValue: string
  sortOrder: number
  primaryImageId: string | null
  images: ProductImage[]
}

export interface ProductColorSwatch {
  id: string
  name: string
  hexValue: string
}

export interface ProductListItem {
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
  colorCount: number
  colors: ProductColorSwatch[]
  createdAt: string
  updatedAt: string
}

export interface Product {
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
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  colors: ProductColor[]
}

/** Body for create / partial update of the product's own fields. */
export interface ProductInput {
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
}

export interface ColorInput {
  name: string
  hexValue: string
  sortOrder?: number
}

/** Image metadata sent after a browser → ImageKit upload. */
export interface NewImageInput {
  imageUrl: string
  imageKitFileId: string
  alt?: string | null
  sortOrder?: number
  isPrimary?: boolean
}

export interface ImageUpdateInput {
  alt?: string | null
  sortOrder?: number
  isPrimary?: boolean
}

export type ProductSort =
  | 'updated-desc'
  | 'created-desc'
  | 'name-asc'
  | 'name-desc'
  | 'price-asc'
  | 'price-desc'
  | 'featured'
  | 'best-seller'

export interface ProductListParams {
  page?: number
  pageSize?: number
  search?: string
  status?: ProductStatus | 'all'
  categoryId?: string
  sort?: ProductSort
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus = 'pending' | 'processing' | 'shipped' | 'delivered' | 'cancelled'
export type PaymentStatus = 'pending' | 'paid' | 'refunded' | 'failed'

export interface OrderLineItem {
  id: string
  productId: string | null
  colorId: string | null
  productName: string
  colorName: string | null
  colorHex: string | null
  imageUrl: string | null
  sku: string
  quantity: number
  unitPrice: number
  subtotal: number
}

export interface OrderCustomer {
  id: string | null
  fullName: string
  email: string
  phone: string | null
}

export interface ShippingAddress {
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
  country: string
}

export interface OrderHistoryEntry {
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  changedByName: string | null
  note: string | null
  createdAt: string
}

export interface OrderListItem {
  id: string
  orderNumber: string
  customerId: string | null
  customerName: string
  customerEmail: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  itemCount: number
  total: number
  currency: string
  createdAt: string
}

export interface Order {
  id: string
  orderNumber: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  allowedTransitions: OrderStatus[]
  currency: string
  customer: OrderCustomer
  shippingAddress: ShippingAddress
  items: OrderLineItem[]
  subtotal: number
  shippingCost: number
  total: number
  history: OrderHistoryEntry[]
  createdAt: string
  updatedAt: string
}

export type OrderSort = 'created-desc' | 'created-asc' | 'total-desc' | 'total-asc'

export interface OrderListParams {
  page?: number
  pageSize?: number
  search?: string
  status?: OrderStatus | 'all'
  paymentStatus?: PaymentStatus | 'all'
  customerId?: string
  /** YYYY-MM-DD, inclusive */
  dateFrom?: string
  /** YYYY-MM-DD, the whole day is included */
  dateTo?: string
  sort?: OrderSort
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface CustomerListItem {
  id: string
  fullName: string
  email: string
  phone: string | null
  ordersCount: number
  totalSpent: number
  lastOrderAt: string | null
  createdAt: string
}

export interface CustomerAddress {
  id: string
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
  country: string
  isDefault: boolean
}

export interface Customer extends CustomerListItem {
  updatedAt: string
  addresses: CustomerAddress[]
}

export type CustomerSort = 'created-desc' | 'name-asc' | 'spent-desc' | 'orders-desc'

export interface CustomerListParams {
  page?: number
  pageSize?: number
  search?: string
  sort?: CustomerSort
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardMetrics {
  currency: string
  products: { total: number; published: number; lowStock: number }
  orders: {
    total: number
    pending: number
    processing: number
    shipped: number
    completed: number
    cancelled: number
  }
  revenue: {
    total: number
    last30Days: number
    previous30Days: number
    /** null when there is no previous period to compare against */
    changePct: number | null
  }
  customers: { total: number }
  recentOrders: OrderListItem[]
}

// ---------------------------------------------------------------------------
// ImageKit
// ---------------------------------------------------------------------------

export interface ImageKitAuthParams {
  token: string
  expire: number
  signature: string
  publicKey: string
  urlEndpoint: string
  folder: string
}
