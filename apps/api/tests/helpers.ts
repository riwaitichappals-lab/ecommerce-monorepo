import type { FastifyInstance } from 'fastify'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { parseConfig } from '../src/app/config.js'
import type { AppConfig } from '../src/app/config.js'
import type { Repositories } from '../src/app/container.js'
import { buildApp } from '../src/app/server.js'
import { InvalidTokenError } from '../src/lib/auth/token-verifier.js'
import type { TokenVerifier } from '../src/lib/auth/token-verifier.js'
import type { Database, Executor } from '../src/lib/db.js'
import type { ImageKitClient } from '../src/lib/imagekit.js'
import { authRepository } from '../src/modules/auth/auth.repository.js'
import type { AdminProfile, AdminRole } from '../src/modules/auth/auth.types.js'
import { categoriesRepository } from '../src/modules/categories/categories.repository.js'
import { customersRepository } from '../src/modules/customers/customers.repository.js'
import { dashboardRepository } from '../src/modules/dashboard/dashboard.repository.js'
import { ordersRepository } from '../src/modules/orders/orders.repository.js'
import { productsRepository } from '../src/modules/products/products.repository.js'
import { assetCleanupRepository } from '../src/modules/uploads/asset-cleanup.repository.js'

export const IMAGEKIT_ENDPOINT = 'https://ik.imagekit.io/test-shop'

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/test',
    SUPABASE_URL: 'https://project.supabase.co',
    IMAGEKIT_PUBLIC_KEY: 'public_test',
    IMAGEKIT_PRIVATE_KEY: 'private_test_secret',
    IMAGEKIT_URL_ENDPOINT: IMAGEKIT_ENDPOINT,
    ...overrides,
  })
}

/** A stand-in executor: repositories are mocked, so it is never queried. */
export const fakeExecutor = {} as Executor

export function fakeDatabase(): Database {
  return {
    sql: fakeExecutor,
    transaction: async (fn) => fn(fakeExecutor),
    ping: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
}

type MockedRepo<T> = { [K in keyof T]: Mock }

/** Replaces every repository function with a vi.fn(). */
export function mockRepository<T extends object>(real: T): MockedRepo<T> {
  return Object.fromEntries(Object.keys(real).map((key) => [key, vi.fn()])) as MockedRepo<T>
}

export function mockRepositories() {
  return {
    auth: mockRepository(authRepository),
    products: mockRepository(productsRepository),
    categories: mockRepository(categoriesRepository),
    orders: mockRepository(ordersRepository),
    customers: mockRepository(customersRepository),
    dashboard: mockRepository(dashboardRepository),
    assetCleanup: mockRepository(assetCleanupRepository),
  }
}

export type MockRepositories = ReturnType<typeof mockRepositories>

export function fakeImageKit(): { [K in keyof ImageKitClient]: Mock } {
  return {
    createUploadAuth: vi.fn(() => ({
      token: 'token-1',
      expire: 1_900_000_000,
      signature: 'sig',
      publicKey: 'public_test',
      urlEndpoint: IMAGEKIT_ENDPOINT,
      folder: '/products',
    })),
    getFileDetails: vi.fn(async (fileId: string) => ({ fileId, url: `${IMAGEKIT_ENDPOINT}/products/${fileId}.jpg` })),
    deleteFile: vi.fn(async () => {}),
    isOwnUrl: vi.fn((url: string) => url.startsWith(`${IMAGEKIT_ENDPOINT}/`)),
    thumbnailUrl: vi.fn((url: string) => `${url}?tr=w-400,h-400,c-at_max`),
  }
}

// --- identities -----------------------------------------------------------------

export const USERS = {
  owner: '00000000-0000-4000-8000-000000000001',
  admin: '00000000-0000-4000-8000-000000000002',
  staff: '00000000-0000-4000-8000-000000000003',
  inactive: '00000000-0000-4000-8000-000000000004',
  customer: '00000000-0000-4000-8000-000000000005', // valid Supabase user, no admin profile
} as const

/** Bearer tokens accepted by the fake verifier, one per identity. */
export const TOKENS = {
  owner: 'owner.token.sig',
  admin: 'admin.token.sig',
  staff: 'staff.token.sig',
  inactive: 'inactive.token.sig',
  customer: 'customer.token.sig',
} as const

export const bearer = (who: keyof typeof TOKENS) => ({ authorization: `Bearer ${TOKENS[who]}` })

export function fakeTokenVerifier(): TokenVerifier {
  const byToken = new Map<string, string>(
    (Object.keys(TOKENS) as (keyof typeof TOKENS)[]).map((who) => [TOKENS[who], USERS[who]]),
  )
  return {
    verify: vi.fn(async (token: string) => {
      const userId = byToken.get(token)
      if (!userId) throw new InvalidTokenError('Invalid token')
      return { userId, email: `${userId}@example.com`, sessionId: null }
    }),
  }
}

function adminProfile(id: string, role: AdminRole, isActive = true): AdminProfile {
  return { id, email: `${role}@example.com`, fullName: `Test ${role}`, role, avatarUrl: null, isActive, createdAt: new Date('2026-01-01T00:00:00Z') }
}

const PROFILES: Record<string, AdminProfile> = {
  [USERS.owner]: adminProfile(USERS.owner, 'owner'),
  [USERS.admin]: adminProfile(USERS.admin, 'admin'),
  [USERS.staff]: adminProfile(USERS.staff, 'staff'),
  [USERS.inactive]: adminProfile(USERS.inactive, 'admin', false),
}

export interface TestApp {
  app: FastifyInstance
  repos: MockRepositories
  imagekit: ReturnType<typeof fakeImageKit>
  tokenVerifier: TokenVerifier
}

export async function buildTestApp(
  configOverrides: Record<string, string> = {},
  extraDeps: { fetch?: typeof fetch } = {},
): Promise<TestApp> {
  const repos = mockRepositories()
  repos.auth.findAdminProfileById.mockImplementation(async (_sql: unknown, id: string) => PROFILES[id] ?? null)
  repos.assetCleanup.enqueue.mockResolvedValue(undefined)
  repos.assetCleanup.claimByFileIds.mockResolvedValue([])

  const imagekit = fakeImageKit()
  const tokenVerifier = fakeTokenVerifier()
  const { app } = await buildApp(testConfig(configOverrides), {
    db: fakeDatabase(),
    tokenVerifier,
    imagekit,
    repositories: repos as unknown as Partial<Repositories>,
    ...extraDeps,
  })
  await app.ready()
  return { app, repos, imagekit, tokenVerifier }
}

// --- fixtures -------------------------------------------------------------------

export const IDS = {
  product: '11111111-1111-4111-8111-111111111111',
  category: '22222222-2222-4222-8222-222222222222',
  colorBlack: '33333333-3333-4333-8333-333333333331',
  colorWhite: '33333333-3333-4333-8333-333333333332',
  image1: '44444444-4444-4444-8444-444444444441',
  image2: '44444444-4444-4444-8444-444444444442',
  image3: '44444444-4444-4444-8444-444444444443',
  order: '55555555-5555-4555-8555-555555555555',
  customer: '66666666-6666-4666-8666-666666666666',
}

export function productRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.product,
    name: 'Classic T Shirt',
    slug: 'classic-t-shirt',
    description: 'Soft cotton tee',
    price: 25,
    compareAtPrice: 30,
    sku: 'TSHIRT-001',
    categoryId: IDS.category,
    category: { id: IDS.category, name: 'Shirts', slug: 'shirts' },
    status: 'published',
    stock: 12,
    isFeatured: false,
    isBestSeller: false,
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-02T00:00:00Z'),
    colors: [
      {
        id: IDS.colorBlack,
        name: 'Black',
        hexValue: '#000000',
        sortOrder: 0,
        images: [
          { id: IDS.image1, imageUrl: `${IMAGEKIT_ENDPOINT}/products/black-1.jpg`, imageKitFileId: 'file_black_1', alt: 'Front', sortOrder: 0, isPrimary: true },
          { id: IDS.image2, imageUrl: `${IMAGEKIT_ENDPOINT}/products/black-2.jpg`, imageKitFileId: 'file_black_2', alt: null, sortOrder: 1, isPrimary: false },
        ],
      },
      {
        id: IDS.colorWhite,
        name: 'White',
        hexValue: '#FFFFFF',
        sortOrder: 1,
        images: [
          { id: IDS.image3, imageUrl: `${IMAGEKIT_ENDPOINT}/products/white-1.jpg`, imageKitFileId: 'file_white_1', alt: null, sortOrder: 0, isPrimary: true },
        ],
      },
    ],
    ...overrides,
  }
}

export function orderRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: IDS.order,
    orderNumber: 'ORD-001001',
    status: 'pending',
    paymentStatus: 'paid',
    currency: 'USD',
    customerId: IDS.customer,
    customerName: 'Jane Doe',
    customerEmail: 'jane@example.com',
    customerPhone: '+1 555 0100',
    shippingLine1: '1 Main St',
    shippingLine2: null,
    shippingCity: 'Springfield',
    shippingState: 'IL',
    shippingPostalCode: '62701',
    shippingCountry: 'US',
    subtotal: 50,
    shippingCost: 5,
    total: 55,
    createdAt: new Date('2026-09-10T10:00:00Z'),
    updatedAt: new Date('2026-09-10T10:00:00Z'),
    items: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        productId: IDS.product,
        productColorId: IDS.colorBlack,
        productName: 'Classic T Shirt (old name)',
        productSku: 'TSHIRT-001',
        colorName: 'Black',
        colorHex: '#000000',
        imageUrl: `${IMAGEKIT_ENDPOINT}/products/black-1.jpg`,
        unitPrice: 25,
        quantity: 2,
        lineTotal: 50,
      },
    ],
    history: [
      { fromStatus: null, toStatus: 'pending', changedByName: null, note: 'Order placed', createdAt: '2026-09-10T10:00:00+00:00' },
    ],
    ...overrides,
  }
}
