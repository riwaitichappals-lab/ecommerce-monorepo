import { z } from 'zod'

/**
 * Building blocks shared by every module's request/response schemas.
 * The envelopes here define the API response contract documented in
 * docs/architecture/api-architecture.md.
 */

export const MAX_PAGE_SIZE = 100

export const paginationQuery = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
}

/** Optional free-text search; blank strings are treated as "no search". */
export const searchQuery = z
  .string()
  .trim()
  .max(200)
  .optional()
  .transform((value) => (value ? value : undefined))

/** Boolean query-string flag: only the literal strings "true" / "false" are accepted. */
export const queryBoolean = z.enum(['true', 'false']).transform((value) => value === 'true')

export const uuidParam = z.uuid({ error: 'Must be a valid UUID' })

export const idParams = z.object({ id: uuidParam })

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens only')

export const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex color such as #1E1E1E')
  .transform((value) => value.toUpperCase())

export const moneySchema = z
  .number()
  .positive()
  .max(9_999_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, {
    message: 'Must have at most two decimal places',
  })

export const isoDateTime = z.iso.datetime({ offset: true })

export const paginationSchema = z.object({
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
})

export const dataEnvelope = <T extends z.ZodType>(schema: T) => z.object({ data: schema })

export const listEnvelope = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), pagination: paginationSchema })

export const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})

/** Error responses shared by all routes, for OpenAPI documentation. */
export const commonErrorResponses = {
  400: errorEnvelope,
  422: errorEnvelope,
  500: errorEnvelope,
} as const

export const authErrorResponses = {
  401: errorEnvelope,
  403: errorEnvelope,
} as const

/** 204 responses carry no body. */
export const noContent = z.null().describe('No content')
