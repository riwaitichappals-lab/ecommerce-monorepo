import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { TokenVerifier } from '../lib/auth/token-verifier.js'
import type { Database } from '../lib/db.js'
import type { ImageKitClient } from '../lib/imagekit.js'
import { buildLoggerOptions } from '../lib/logger.js'
import { createAuthGuards } from '../middleware/auth.js'
import { authRoutes } from '../modules/auth/auth.routes.js'
import { createCategoriesController } from '../modules/categories/categories.controller.js'
import { categoriesAdminRoutes, categoriesStoreRoutes } from '../modules/categories/categories.routes.js'
import { createCustomersController } from '../modules/customers/customers.controller.js'
import { customersAdminRoutes } from '../modules/customers/customers.routes.js'
import { createDashboardController } from '../modules/dashboard/dashboard.controller.js'
import { dashboardAdminRoutes } from '../modules/dashboard/dashboard.routes.js'
import { healthRoutes } from '../modules/health/health.routes.js'
import { createOrdersController } from '../modules/orders/orders.controller.js'
import { ordersAdminRoutes, ordersStoreRoutes } from '../modules/orders/orders.routes.js'
import { createProductsController } from '../modules/products/products.controller.js'
import { productsAdminRoutes, productsReadRoutes, productsStoreRoutes } from '../modules/products/products.routes.js'
import { uploadsAdminRoutes } from '../modules/uploads/uploads.routes.js'
import { registerErrorHandler } from '../plugins/error-handler.js'
import { registerSecurity } from '../plugins/security.js'
import { registerApiDocs } from '../plugins/swagger.js'
import type { AppConfig } from './config.js'
import { createServices } from './container.js'
import type { Repositories, Services } from './container.js'

export interface AppDependencies {
  db: Database
  tokenVerifier: TokenVerifier
  imagekit: ImageKitClient
  /** Test seam: replace individual repositories with fakes. */
  repositories?: Partial<Repositories>
  /** Test seam: replaces the global fetch used for the storefront webhook. */
  fetch?: typeof fetch
  /** Serverless platforms: keeps the webhook call alive after the response is sent. */
  waitUntil?: (promise: Promise<unknown>) => void
}

export interface App {
  app: FastifyInstance
  services: Services
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/

/**
 * Builds the Fastify application. Pure composition: no listening, no
 * background jobs (see src/index.ts), so tests can build it with fakes.
 */
export async function buildApp(config: AppConfig, deps: AppDependencies): Promise<App> {
  const app = Fastify({
    logger: buildLoggerOptions(config),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Reuse a caller-supplied request id (e.g. from a gateway) when well-formed.
    genReqId: (request) => {
      const header = request.headers['x-request-id']
      return typeof header === 'string' && REQUEST_ID_PATTERN.test(header) ? header : randomUUID()
    },
    routerOptions: { ignoreTrailingSlash: true },
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  app.decorateRequest('auth', null)
  app.decorateRequest('admin', null)
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-Id', request.id)
  })

  registerErrorHandler(app, { exposeInternalMessages: !config.isProduction })
  await registerSecurity(app, config)
  if (config.apiDocsEnabled) await registerApiDocs(app)

  const services = createServices({ ...deps, config, logger: app.log })
  app.decorate('guards', createAuthGuards({ tokenVerifier: deps.tokenVerifier, authService: services.auth }))

  const mapperContext = {
    thumbnailUrl: (url: string) => deps.imagekit.thumbnailUrl(url),
    currency: config.commerce.currency,
    storeCacheMaxAge: config.store.cacheMaxAge,
  }
  const products = createProductsController(services.products, mapperContext)
  const categories = createCategoriesController(services.categories, mapperContext)
  const orders = createOrdersController(services.orders)

  await app.register(healthRoutes(deps.db), { prefix: '/health' })

  // Admin dashboard API (authenticated + admin role)
  await app.register(authRoutes, { prefix: '/api/auth' })
  await app.register(productsReadRoutes(products), { prefix: '/api/products' })
  await app.register(productsAdminRoutes(products), { prefix: '/api/admin/products' })
  await app.register(categoriesAdminRoutes(categories), { prefix: '/api/admin/categories' })
  await app.register(ordersAdminRoutes(orders), { prefix: '/api/admin/orders' })
  await app.register(customersAdminRoutes(createCustomersController(services.customers)), {
    prefix: '/api/admin/customers',
  })
  await app.register(dashboardAdminRoutes(createDashboardController(services.dashboard, mapperContext)), {
    prefix: '/api/admin/dashboard',
  })
  await app.register(uploadsAdminRoutes(services.uploads), { prefix: '/api/admin/uploads' })

  // Public storefront API (no auth, public fields only)
  await app.register(productsStoreRoutes(products), { prefix: '/api/store/products' })
  await app.register(categoriesStoreRoutes(categories), { prefix: '/api/store/categories' })
  await app.register(ordersStoreRoutes(orders, { rateLimitMax: config.rateLimit.checkoutMax }), {
    prefix: '/api/store/orders',
  })

  return { app, services }
}
