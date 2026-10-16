import type { FastifyReply } from 'fastify'
import { ok, paginated, setNoStore, setPublicCache } from '../../utils/http.js'
import {
  toAdminColor,
  toAdminImage,
  toAdminProduct,
  toAdminProductListItem,
  toStoreProduct,
  toStoreProductListItem,
} from './products.mapper.js'
import type { MapperContext } from './products.mapper.js'
import type {
  AdminProductListQuery,
  CreateProductBody,
  StoreProductListQuery,
  UpdateProductBody,
} from './products.schemas.js'
import type { ProductsService } from './products.service.js'
import type { NewColorInput, NewImageInput, ProductSort, UpdateColorInput, UpdateImageInput } from './products.types.js'

const STORE_SORT: Record<StoreProductListQuery['sort'], ProductSort> = {
  newest: 'created-desc',
  'price-asc': 'price-asc',
  'price-desc': 'price-desc',
  'name-asc': 'name-asc',
  featured: 'featured',
  'best-seller': 'best-seller',
}

/**
 * Controllers translate validated HTTP input into service calls and service
 * results into response envelopes. No business logic lives here.
 */
export function createProductsController(
  service: ProductsService,
  ctx: MapperContext & { storeCacheMaxAge: number },
) {
  return {
    // --- admin ------------------------------------------------------------------

    async adminList(query: AdminProductListQuery, reply: FastifyReply) {
      setNoStore(reply)
      const page = { page: query.page, pageSize: query.pageSize }
      const result = await service.list(
        {
          search: query.search,
          status: query.status,
          categoryId: query.categoryId,
          featured: query.featured,
          sort: query.sort,
        },
        page,
      )
      return paginated({ items: result.items.map(toAdminProductListItem), total: result.total }, page)
    },

    async adminGet(id: string, reply: FastifyReply) {
      setNoStore(reply)
      return ok(toAdminProduct(await service.getById(id), ctx))
    },

    async create(body: CreateProductBody, reply: FastifyReply) {
      const product = await service.create(body)
      reply.code(201).header('Location', `/api/products/${product.id}`)
      return ok(toAdminProduct(product, ctx))
    },

    async update(id: string, body: UpdateProductBody) {
      return ok(toAdminProduct(await service.update(id, body), ctx))
    },

    async remove(id: string, reply: FastifyReply) {
      await service.delete(id)
      return reply.code(204).send()
    },

    async addColor(productId: string, body: NewColorInput, reply: FastifyReply) {
      const color = await service.addColor(productId, body)
      reply.code(201)
      return ok(toAdminColor(color, ctx))
    },

    async updateColor(productId: string, colorId: string, body: UpdateColorInput) {
      return ok(toAdminColor(await service.updateColor(productId, colorId, body), ctx))
    },

    async removeColor(productId: string, colorId: string, reply: FastifyReply) {
      await service.deleteColor(productId, colorId)
      return reply.code(204).send()
    },

    async addImage(productId: string, colorId: string, body: NewImageInput, reply: FastifyReply) {
      const image = await service.addImage(productId, colorId, body)
      reply.code(201)
      return ok(toAdminImage(image, ctx))
    },

    async updateImage(productId: string, colorId: string, imageId: string, body: UpdateImageInput) {
      return ok(toAdminImage(await service.updateImage(productId, colorId, imageId, body), ctx))
    },

    async removeImage(productId: string, colorId: string, imageId: string, reply: FastifyReply) {
      await service.deleteImage(productId, colorId, imageId)
      return reply.code(204).send()
    },

    // --- storefront -------------------------------------------------------------

    async storeList(query: StoreProductListQuery, reply: FastifyReply) {
      setPublicCache(reply, ctx.storeCacheMaxAge)
      const page = { page: query.page, pageSize: query.pageSize }
      const result = await service.list(
        {
          publishedOnly: true,
          search: query.search,
          categorySlug: query.category,
          minPrice: query.minPrice,
          maxPrice: query.maxPrice,
          featured: query.featured,
          sort: STORE_SORT[query.sort],
        },
        page,
      )
      return paginated(
        { items: result.items.map((item) => toStoreProductListItem(item, ctx)), total: result.total },
        page,
      )
    },

    async storeGetBySlug(slug: string, reply: FastifyReply) {
      setPublicCache(reply, ctx.storeCacheMaxAge)
      return ok(toStoreProduct(await service.getPublishedBySlug(slug), ctx))
    },
  }
}

export type ProductsController = ReturnType<typeof createProductsController>
