import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../src/lib/errors.js'
import { productsRepository } from '../src/modules/products/products.repository.js'
import { ProductsService } from '../src/modules/products/products.service.js'
import { AssetCleanupService } from '../src/modules/uploads/asset-cleanup.service.js'
import { UploadsService } from '../src/modules/uploads/uploads.service.js'
import { assetCleanupRepository } from '../src/modules/uploads/asset-cleanup.repository.js'
import { fakeDatabase, fakeImageKit, IDS, IMAGEKIT_ENDPOINT, mockRepository, productRecord } from './helpers.js'

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never

function setup(options: { verifyUploads?: boolean } = {}) {
  const repo = mockRepository(productsRepository)
  const assetRepo = mockRepository(assetCleanupRepository)
  const imagekit = fakeImageKit()
  const db = fakeDatabase()
  const uploads = new UploadsService(imagekit, { verifyUploads: options.verifyUploads ?? true })
  const assets = new AssetCleanupService(db, assetRepo, imagekit, silentLogger)
  const revalidator = { revalidateStorefront: vi.fn() }
  const service = new ProductsService(db, repo, uploads, assets, revalidator)

  repo.findById.mockResolvedValue(productRecord())
  repo.categoryExists.mockResolvedValue(true)
  repo.insertProduct.mockResolvedValue(IDS.product)
  let colorSeq = 0
  repo.insertColor.mockImplementation(async () => `color-${++colorSeq}`)
  repo.insertImage.mockResolvedValue(IDS.image1)
  assetRepo.enqueue.mockResolvedValue(undefined)
  assetRepo.claimByFileIds.mockImplementation(async (_sql: unknown, ids: string[]) =>
    ids.map((id, i) => ({ id: `q-${i}`, imagekitFileId: id, attempts: 0 })),
  )
  assetRepo.complete.mockResolvedValue(undefined)
  assetRepo.fail.mockResolvedValue(undefined)

  return { service, repo, assetRepo, imagekit, revalidator }
}

const image = (fileId: string, extra: Record<string, unknown> = {}) => ({
  imageUrl: `${IMAGEKIT_ENDPOINT}/products/${fileId}.jpg`,
  imageKitFileId: fileId,
  ...extra,
})

const baseInput = {
  name: 'Classic T Shirt',
  slug: 'classic-t-shirt',
  description: '',
  price: 25,
  compareAtPrice: null,
  sku: 'TSHIRT-001',
  categoryId: IDS.category,
  status: 'draft' as const,
  stock: 10,
  isFeatured: false,
  isBestSeller: false,
  colors: [],
}

describe('ProductsService.create', () => {
  it('creates the product, its colors and images in one transaction', async () => {
    const { service, repo } = setup()
    const result = await service.create({
      ...baseInput,
      colors: [
        { name: 'Black', hexValue: '#000000', images: [image('a'), image('b', { isPrimary: true })] },
        { name: 'White', hexValue: '#FFFFFF', images: [image('c')] },
      ],
    })

    expect(repo.insertProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ slug: 'classic-t-shirt', price: 25 }))
    expect(repo.insertColor).toHaveBeenNthCalledWith(1, expect.anything(), IDS.product, { name: 'Black', hexValue: '#000000', sortOrder: 0 })
    expect(repo.insertColor).toHaveBeenNthCalledWith(2, expect.anything(), IDS.product, { name: 'White', hexValue: '#FFFFFF', sortOrder: 1 })
    expect(repo.insertImage).toHaveBeenCalledTimes(3)
    // The explicitly flagged image becomes primary; only one per color.
    expect(repo.insertImage.mock.calls.map((call) => [call[1], call[2].imageKitFileId, call[2].isPrimary])).toEqual([
      ['color-1', 'a', false],
      ['color-1', 'b', true],
      ['color-2', 'c', true],
    ])
    expect(result.colors[0]!.images).toHaveLength(2)
  })

  it('refuses to publish a product without colors or with an image-less color', async () => {
    const { service, repo } = setup()
    await expect(service.create({ ...baseInput, status: 'published' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'BUSINESS_RULE_VIOLATION',
    })
    await expect(
      service.create({ ...baseInput, status: 'published', colors: [{ name: 'Black', hexValue: '#000000', images: [] }] }),
    ).rejects.toMatchObject({ statusCode: 422 })
    expect(repo.insertProduct).not.toHaveBeenCalled()
  })

  it('rejects an unknown category', async () => {
    const { service, repo } = setup()
    repo.categoryExists.mockResolvedValue(false)
    await expect(service.create(baseInput)).rejects.toMatchObject({ statusCode: 422, message: 'Category does not exist' })
  })

  it('maps a duplicate slug to 409 CONFLICT', async () => {
    const { service, repo } = setup()
    repo.insertProduct.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { name: 'PostgresError', code: '23505', constraint_name: 'products_slug_key' }),
    )
    await expect(service.create(baseInput)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'A product with this slug already exists',
    })
  })

  it('rejects images that are not on the configured ImageKit endpoint', async () => {
    const { service, repo } = setup()
    await expect(
      service.create({
        ...baseInput,
        colors: [{ name: 'Black', hexValue: '#000000', images: [{ imageUrl: 'https://evil.example.com/x.jpg', imageKitFileId: 'x' }] }],
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_IMAGE' })
    expect(repo.insertProduct).not.toHaveBeenCalled()
  })
})

describe('ProductsService.update', () => {
  it('validates compareAtPrice against the stored price when only one side changes', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: 30, publishedAt: null })
    await expect(service.update(IDS.product, { price: 40 })).rejects.toMatchObject({ statusCode: 422 })
    expect(repo.updateProduct).not.toHaveBeenCalled()
  })

  it('updates scalar fields and returns the refreshed product', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    await service.update(IDS.product, { name: 'Renamed', stock: 3 })
    expect(repo.updateProduct).toHaveBeenCalledWith(expect.anything(), IDS.product, { name: 'Renamed', stock: 3 })
    expect(repo.findById).toHaveBeenCalled()
  })

  it('returns 404 for a missing product', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue(null)
    await expect(service.update(IDS.product, { name: 'x' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('blocks publishing when a color has no images', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    repo.colorImageCounts.mockResolvedValue([
      { colorId: IDS.colorBlack, imageCount: 2 },
      { colorId: IDS.colorWhite, imageCount: 0 },
    ])
    await expect(service.update(IDS.product, { status: 'published' })).rejects.toMatchObject({
      statusCode: 422,
      details: { colorIds: [IDS.colorWhite] },
    })
  })

  it('syncs colors: updates kept ones, deletes dropped ones and queues their ImageKit files', async () => {
    const { service, repo, assetRepo, imagekit } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    repo.colorImageMap.mockResolvedValue([
      { colorId: IDS.colorBlack, images: [{ id: IDS.image1, imageKitFileId: 'file_black_1' }, { id: IDS.image2, imageKitFileId: 'file_black_2' }] },
      { colorId: IDS.colorWhite, images: [{ id: IDS.image3, imageKitFileId: 'file_white_1' }] },
    ])

    await service.update(IDS.product, {
      colors: [
        {
          id: IDS.colorBlack,
          name: 'Jet Black',
          hexValue: '#111111',
          images: [{ id: IDS.image2, isPrimary: true }, image('new_file')],
        },
      ],
    })

    expect(repo.deleteColor).toHaveBeenCalledWith(expect.anything(), IDS.colorWhite)
    expect(repo.deleteImage).toHaveBeenCalledWith(expect.anything(), IDS.image1)
    expect(repo.updateColor).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack, { name: 'Jet Black', hexValue: '#111111', sortOrder: 0 })
    expect(repo.updateImage).toHaveBeenCalledWith(expect.anything(), IDS.image2, { alt: undefined, sortOrder: 0, isPrimary: true })
    expect(repo.insertImage).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack, expect.objectContaining({ imageKitFileId: 'new_file', isPrimary: false, sortOrder: 1 }))
    expect(assetRepo.enqueue).toHaveBeenCalledWith(expect.anything(), ['file_white_1', 'file_black_1'])
    expect(imagekit.deleteFile).toHaveBeenCalledWith('file_white_1')
    expect(imagekit.deleteFile).toHaveBeenCalledWith('file_black_1')
  })

  it('rejects a color id that belongs to another product', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    repo.colorImageMap.mockResolvedValue([])
    await expect(
      service.update(IDS.product, { colors: [{ id: IDS.colorBlack, name: 'Black', hexValue: '#000000', images: [] }] }),
    ).rejects.toMatchObject({ statusCode: 422 })
  })
})

describe('ProductsService colors', () => {
  it('adds a color with images and returns it', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    repo.nextColorSortOrder.mockResolvedValue(2)
    repo.insertColor.mockResolvedValue(IDS.colorWhite)

    const color = await service.addColor(IDS.product, { name: 'White', hexValue: '#FFFFFF', images: [image('w1')] })

    expect(repo.insertColor).toHaveBeenCalledWith(expect.anything(), IDS.product, { name: 'White', hexValue: '#FFFFFF', sortOrder: 2 })
    expect(repo.insertImage).toHaveBeenCalledWith(expect.anything(), IDS.colorWhite, expect.objectContaining({ imageKitFileId: 'w1', isPrimary: true }))
    expect(color.id).toBe(IDS.colorWhite)
  })

  it('requires images when adding a color to a published product', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'published', price: 25, compareAtPrice: null, publishedAt: new Date() })
    await expect(service.addColor(IDS.product, { name: 'Blue', hexValue: '#0000FF', images: [] })).rejects.toMatchObject({ statusCode: 422 })
    expect(repo.insertColor).not.toHaveBeenCalled()
  })

  it('maps a duplicate color name to 409', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    repo.nextColorSortOrder.mockResolvedValue(0)
    repo.insertColor.mockRejectedValue(
      Object.assign(new Error('dup'), { name: 'PostgresError', code: '23505', constraint_name: 'product_colors_product_name_key' }),
    )
    await expect(service.addColor(IDS.product, { name: 'Black', hexValue: '#000000', images: [] })).rejects.toMatchObject({ statusCode: 409 })
  })

  it('will not delete the last color of a published product', async () => {
    const { service, repo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'published', price: 25, compareAtPrice: null, publishedAt: new Date() })
    repo.findColor.mockResolvedValue({ id: IDS.colorBlack })
    repo.colorImageCounts.mockResolvedValue([{ colorId: IDS.colorBlack, imageCount: 1 }])
    await expect(service.deleteColor(IDS.product, IDS.colorBlack)).rejects.toBeInstanceOf(AppError)
    expect(repo.deleteColor).not.toHaveBeenCalled()
  })
})

describe('ProductsService images', () => {
  function withColor(status: 'draft' | 'published') {
    const ctx = setup()
    ctx.repo.lockProduct.mockResolvedValue({ id: IDS.product, status, price: 25, compareAtPrice: null, publishedAt: null })
    ctx.repo.findColor.mockResolvedValue({ id: IDS.colorBlack })
    ctx.repo.findImageById.mockResolvedValue({ id: IDS.image1, imageUrl: `${IMAGEKIT_ENDPOINT}/products/a.jpg`, imageKitFileId: 'a', alt: null, sortOrder: 0, isPrimary: true })
    return ctx
  }

  it('associates an uploaded image with a color; the first image becomes primary', async () => {
    const { service, repo, imagekit } = withColor('draft')
    repo.countImages.mockResolvedValue(0)
    repo.nextImageSortOrder.mockResolvedValue(0)

    const result = await service.addImage(IDS.product, IDS.colorBlack, image('a'))

    expect(imagekit.getFileDetails).toHaveBeenCalledWith('a')
    expect(repo.clearPrimary).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack)
    expect(repo.insertImage).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack, {
      imageUrl: `${IMAGEKIT_ENDPOINT}/products/a.jpg`,
      imageKitFileId: 'a',
      alt: null,
      sortOrder: 0,
      isPrimary: true,
    })
    expect(result.id).toBe(IDS.image1)
  })

  it('does not change the primary image when adding a non-primary one', async () => {
    const { service, repo } = withColor('draft')
    repo.countImages.mockResolvedValue(2)
    repo.nextImageSortOrder.mockResolvedValue(2)
    await service.addImage(IDS.product, IDS.colorBlack, image('b'))
    expect(repo.clearPrimary).not.toHaveBeenCalled()
    expect(repo.insertImage).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack, expect.objectContaining({ isPrimary: false, sortOrder: 2 }))
  })

  it('rejects metadata whose file does not exist in ImageKit', async () => {
    const { service, repo, imagekit } = withColor('draft')
    imagekit.getFileDetails.mockResolvedValue(null)
    await expect(service.addImage(IDS.product, IDS.colorBlack, image('ghost'))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
    expect(repo.insertImage).not.toHaveBeenCalled()
  })

  it('rejects metadata whose URL does not match the ImageKit file', async () => {
    const { service, imagekit } = withColor('draft')
    imagekit.getFileDetails.mockResolvedValue({ fileId: 'a', url: `${IMAGEKIT_ENDPOINT}/someone-else.jpg` })
    await expect(service.addImage(IDS.product, IDS.colorBlack, image('a'))).rejects.toMatchObject({ code: 'INVALID_IMAGE' })
  })

  it('returns 404 when the color belongs to another product', async () => {
    const { service, repo } = withColor('draft')
    repo.findColor.mockResolvedValue(null)
    await expect(service.addImage(IDS.product, IDS.colorBlack, image('a'))).rejects.toMatchObject({ statusCode: 404, message: 'Color not found' })
  })

  it('deletes the DB row, promotes a new primary, then deletes the ImageKit asset', async () => {
    const { service, repo, assetRepo, imagekit } = withColor('draft')
    repo.findImage.mockResolvedValue({ id: IDS.image1, isPrimary: true, imageKitFileId: 'file_black_1' })

    await service.deleteImage(IDS.product, IDS.colorBlack, IDS.image1)

    expect(repo.deleteImage).toHaveBeenCalledWith(expect.anything(), IDS.image1)
    expect(repo.ensurePrimary).toHaveBeenCalledWith(expect.anything(), IDS.colorBlack)
    expect(assetRepo.enqueue).toHaveBeenCalledWith(expect.anything(), ['file_black_1'])
    expect(imagekit.deleteFile).toHaveBeenCalledWith('file_black_1')
    expect(assetRepo.complete).toHaveBeenCalled()
  })

  it('keeps the queue entry when ImageKit deletion fails, without failing the request', async () => {
    const { service, repo, assetRepo, imagekit } = withColor('draft')
    repo.findImage.mockResolvedValue({ id: IDS.image1, isPrimary: false, imageKitFileId: 'file_black_1' })
    imagekit.deleteFile.mockRejectedValue(new Error('ImageKit down'))

    await expect(service.deleteImage(IDS.product, IDS.colorBlack, IDS.image1)).resolves.toBeUndefined()
    expect(repo.deleteImage).toHaveBeenCalled()
    expect(assetRepo.complete).not.toHaveBeenCalled()
    expect(assetRepo.fail).toHaveBeenCalledWith(expect.anything(), 'q-0', 'ImageKit down', 60)
  })

  it('is idempotent when the image is already gone', async () => {
    const { service, repo, imagekit } = withColor('draft')
    repo.findImage.mockResolvedValue(null)
    await expect(service.deleteImage(IDS.product, IDS.colorBlack, IDS.image1)).resolves.toBeUndefined()
    expect(repo.deleteImage).not.toHaveBeenCalled()
    expect(imagekit.deleteFile).not.toHaveBeenCalled()
  })

  it('will not remove the last image of a color on a published product', async () => {
    const { service, repo } = withColor('published')
    repo.findImage.mockResolvedValue({ id: IDS.image1, isPrimary: true, imageKitFileId: 'file_black_1' })
    repo.countImages.mockResolvedValue(1)
    await expect(service.deleteImage(IDS.product, IDS.colorBlack, IDS.image1)).rejects.toMatchObject({ statusCode: 422 })
    expect(repo.deleteImage).not.toHaveBeenCalled()
  })
})

describe('ProductsService.delete', () => {
  it('deletes the product and queues every image asset for cleanup', async () => {
    const { service, repo, assetRepo } = setup()
    repo.lockProduct.mockResolvedValue({ id: IDS.product, slug: 'classic-t-shirt', status: 'draft', price: 25, compareAtPrice: null, publishedAt: null })
    repo.listImageFileIdsForProduct.mockResolvedValue(['f1', 'f2'])
    await service.delete(IDS.product)
    expect(repo.deleteProduct).toHaveBeenCalledWith(expect.anything(), IDS.product)
    expect(assetRepo.enqueue).toHaveBeenCalledWith(expect.anything(), ['f1', 'f2'])
  })
})
