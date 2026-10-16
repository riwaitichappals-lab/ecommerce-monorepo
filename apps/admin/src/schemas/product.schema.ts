import { z } from 'zod'

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const hexPattern = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/**
 * Product details form (name, price, stock, …). Colors and images are managed
 * separately on the edit page: each change is saved immediately through the
 * color/image endpoints, so they are not part of this form.
 *
 * Field names match the API body so `ApiError.fieldErrors` can be applied to
 * the form directly.
 */
export const productFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Product name is required').max(200),
    slug: z
      .string()
      .min(1, 'Slug is required')
      .max(200)
      .regex(slugPattern, 'Use lowercase letters, numbers and hyphens only'),
    description: z.string().max(10000),
    price: z.number({ error: 'Price is required' }).positive('Price must be greater than 0'),
    compareAtPrice: z.number().positive().nullable(),
    sku: z.string().trim().min(1, 'SKU is required').max(100),
    categoryId: z.string().nullable(),
    status: z.enum(['draft', 'published', 'archived']),
    stock: z
      .number({ error: 'Stock is required' })
      .int('Stock must be a whole number')
      .min(0)
      .max(1_000_000),
    isFeatured: z.boolean(),
    isBestSeller: z.boolean(),
  })
  .refine((data) => data.compareAtPrice === null || data.compareAtPrice > data.price, {
    message: 'Compare-at price must be greater than the price',
    path: ['compareAtPrice'],
  })

export type ProductFormValues = z.infer<typeof productFormSchema>

export const colorFormSchema = z.object({
  name: z.string().trim().min(1, 'Color name is required').max(50),
  hexValue: z.string().regex(hexPattern, 'Enter a valid hex color, e.g. #1E1E1E'),
})

export type ColorFormValues = z.infer<typeof colorFormSchema>

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}
