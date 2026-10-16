import type { FastifyBaseLogger } from 'fastify'
import type { Database } from '../lib/db.js'
import type { ImageKitClient } from '../lib/imagekit.js'
import { createStorefrontRevalidator } from '../lib/storefront-revalidate.js'
import { authRepository } from '../modules/auth/auth.repository.js'
import { AuthService } from '../modules/auth/auth.service.js'
import { categoriesRepository } from '../modules/categories/categories.repository.js'
import { CategoriesService } from '../modules/categories/categories.service.js'
import { customersRepository } from '../modules/customers/customers.repository.js'
import { CustomersService } from '../modules/customers/customers.service.js'
import { dashboardRepository } from '../modules/dashboard/dashboard.repository.js'
import { DashboardService } from '../modules/dashboard/dashboard.service.js'
import { ordersRepository } from '../modules/orders/orders.repository.js'
import { OrdersService } from '../modules/orders/orders.service.js'
import { productsRepository } from '../modules/products/products.repository.js'
import { ProductsService } from '../modules/products/products.service.js'
import { assetCleanupRepository } from '../modules/uploads/asset-cleanup.repository.js'
import { AssetCleanupService } from '../modules/uploads/asset-cleanup.service.js'
import { UploadsService } from '../modules/uploads/uploads.service.js'
import type { AppConfig } from './config.js'

/**
 * Composition root: wires repositories → services. Plain constructor
 * injection, no DI framework.
 */

export interface Repositories {
  auth: typeof authRepository
  products: typeof productsRepository
  categories: typeof categoriesRepository
  orders: typeof ordersRepository
  customers: typeof customersRepository
  dashboard: typeof dashboardRepository
  assetCleanup: typeof assetCleanupRepository
}

export interface Services {
  auth: AuthService
  products: ProductsService
  categories: CategoriesService
  orders: OrdersService
  customers: CustomersService
  dashboard: DashboardService
  uploads: UploadsService
  assets: AssetCleanupService
}

export function createServices(deps: {
  config: AppConfig
  db: Database
  imagekit: ImageKitClient
  logger: FastifyBaseLogger
  repositories?: Partial<Repositories> | undefined
  /** Test seam for the storefront webhook call. */
  fetch?: typeof fetch | undefined
  /** Serverless hook that keeps the webhook call alive after the response (Vercel waitUntil). */
  waitUntil?: ((promise: Promise<unknown>) => void) | undefined
}): Services {
  const repos: Repositories = {
    auth: authRepository,
    products: productsRepository,
    categories: categoriesRepository,
    orders: ordersRepository,
    customers: customersRepository,
    dashboard: dashboardRepository,
    assetCleanup: assetCleanupRepository,
    ...deps.repositories,
  }

  const uploads = new UploadsService(deps.imagekit, { verifyUploads: deps.config.imagekit.verifyUploads })
  const assets = new AssetCleanupService(deps.db, repos.assetCleanup, deps.imagekit, deps.logger)
  const revalidator = createStorefrontRevalidator({
    url: deps.config.storefront.revalidateUrl,
    secret: deps.config.storefront.revalidateSecret,
    logger: deps.logger,
    fetch: deps.fetch,
    waitUntil: deps.waitUntil,
  })

  return {
    auth: new AuthService(deps.db, repos.auth),
    products: new ProductsService(deps.db, repos.products, uploads, assets, revalidator),
    categories: new CategoriesService(deps.db, repos.categories, revalidator),
    orders: new OrdersService(deps.db, repos.orders, deps.config.commerce, revalidator),
    customers: new CustomersService(deps.db, repos.customers),
    dashboard: new DashboardService(deps.db, repos.dashboard, repos.orders),
    uploads,
    assets,
  }
}
