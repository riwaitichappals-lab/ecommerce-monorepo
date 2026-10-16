import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Textarea,
  TextInput,
} from '@mantine/core'
import { useForm } from '@mantine/form'
import { IconRefresh } from '@tabler/icons-react'
import { zod4Resolver } from 'mantine-form-zod-resolver'
import { ApiError } from '@/lib/api/client'
import { currencySymbol } from '@/lib/format'
import { buildSku, randomSkuSuffix } from '@/lib/sku'
import { productFormSchema, slugify, type ProductFormValues } from '@/schemas/product.schema'
import { useCurrency } from '@/features/dashboard/hooks/use-currency'
import { useCategoryOptions } from '@/features/categories/hooks/use-categories'
import type { Product } from '@/types/api'

interface ProductFormProps {
  product?: Product
  onSubmit: (values: ProductFormValues) => Promise<unknown>
  submitting: boolean
  submitLabel: string
  /** Staff can view a product but not change it. */
  readOnly?: boolean
}

function toFormValues(product?: Product): ProductFormValues {
  return {
    name: product?.name ?? '',
    slug: product?.slug ?? '',
    description: product?.description ?? '',
    price: product?.price ?? 0,
    compareAtPrice: product?.compareAtPrice ?? null,
    sku: product?.sku ?? '',
    categoryId: product?.categoryId ?? null,
    status: product?.status ?? 'draft',
    stock: product?.stock ?? 0,
    isFeatured: product?.isFeatured ?? false,
    isBestSeller: product?.isBestSeller ?? false,
  }
}

export function ProductForm({
  product,
  onSubmit,
  submitting,
  submitLabel,
  readOnly = false,
}: ProductFormProps) {
  const currency = useCurrency()
  const { data: categories } = useCategoryOptions()
  const [slugTouched, setSlugTouched] = useState(Boolean(product))
  // New products get a generated SKU; typing in the field switches auto-generation off.
  const [skuTouched, setSkuTouched] = useState(Boolean(product))
  const [skuSuffix, setSkuSuffix] = useState(randomSkuSuffix)

  const form = useForm<ProductFormValues>({
    initialValues: product ? toFormValues(product) : { ...toFormValues(), sku: buildSku('', skuSuffix) },
    validate: zod4Resolver(productFormSchema),
  })

  // Publishing from the page header changes the status outside this form: keep the select in sync.
  useEffect(() => {
    if (product) form.setFieldValue('status', product.status)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.status])

  const categoryOptions = (categories ?? []).map((category) => ({
    value: category.id,
    label: category.isActive ? category.name : `${category.name} (hidden)`,
  }))
  // Keep the product's own category selectable even if it is beyond the first page of options.
  if (product?.category && !categoryOptions.some((o) => o.value === product.category?.id)) {
    categoryOptions.push({ value: product.category.id, label: product.category.name })
  }

  const handleSubmit = async (values: ProductFormValues) => {
    try {
      await onSubmit(values)
      form.resetDirty(values)
    } catch (error) {
      if (!(error instanceof ApiError)) return
      form.setErrors(error.fieldErrors)
      // 409s name the clashing field in the message ("... slug already exists").
      if (error.isConflict) {
        const field = /sku/i.test(error.message) ? 'sku' : 'slug'
        if (field === 'sku' && !product && !skuTouched) {
          // Generated SKU collided (very unlikely): draw a new one and try once more.
          const nextSuffix = randomSkuSuffix()
          setSkuSuffix(nextSuffix)
          const sku = buildSku(values.name, nextSuffix)
          form.setFieldValue('sku', sku)
          try {
            await onSubmit({ ...values, sku })
            form.resetDirty({ ...values, sku })
          } catch (retryError) {
            if (retryError instanceof ApiError) form.setErrors(retryError.fieldErrors)
          }
          return
        }
        form.setFieldError(field, error.message)
      }
    }
  }

  return (
    <form onSubmit={form.onSubmit((values) => void handleSubmit(values))}>
      <Paper withBorder radius="md" p="lg">
        {/* A disabled fieldset disables every control inside it. */}
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <Stack gap="md">
            <Group grow align="flex-start">
              <TextInput
                label="Product name"
                placeholder="Classic T Shirt"
                required
                value={form.values.name}
                onChange={(e) => {
                  const name = e.currentTarget.value
                  form.setFieldValue('name', name)
                  if (!slugTouched) form.setFieldValue('slug', slugify(name))
                  if (!skuTouched) form.setFieldValue('sku', buildSku(name, skuSuffix))
                }}
                error={form.errors.name}
              />
              <TextInput
                label="Slug"
                description="Used in the storefront URL"
                required
                {...form.getInputProps('slug')}
                onChange={(e) => {
                  setSlugTouched(true)
                  form.setFieldValue('slug', e.currentTarget.value)
                }}
              />
            </Group>

            <Textarea
              label="Description"
              placeholder="Describe the product…"
              minRows={4}
              autosize
              {...form.getInputProps('description')}
            />

            <Group grow align="flex-start">
              <TextInput
                label="SKU"
                description={product ? undefined : 'Generated automatically, edit if you prefer'}
                required
                {...form.getInputProps('sku')}
                onChange={(e) => {
                  setSkuTouched(true)
                  form.setFieldValue('sku', e.currentTarget.value)
                }}
                rightSection={
                  product || readOnly ? undefined : (
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      aria-label="Generate a new SKU"
                      onClick={() => {
                        const nextSuffix = randomSkuSuffix()
                        setSkuSuffix(nextSuffix)
                        setSkuTouched(false)
                        form.setFieldValue('sku', buildSku(form.values.name, nextSuffix))
                      }}
                    >
                      <IconRefresh size={16} />
                    </ActionIcon>
                  )
                }
              />
              <Select
                label="Category"
                placeholder="No category"
                data={categoryOptions}
                searchable
                clearable
                {...form.getInputProps('categoryId')}
              />
              <Select
                label="Status"
                description="Publishing needs a color with an image"
                data={[
                  { value: 'draft', label: 'Draft' },
                  { value: 'published', label: 'Published' },
                  { value: 'archived', label: 'Archived' },
                ]}
                allowDeselect={false}
                {...form.getInputProps('status')}
              />
            </Group>

            <Group grow align="flex-start">
              <NumberInput
                label="Price"
                required
                min={0}
                decimalScale={2}
                fixedDecimalScale
                prefix={currencySymbol(currency)}
                {...form.getInputProps('price')}
              />
              <NumberInput
                label="Compare-at price"
                description="Optional: shown as a strikethrough price"
                min={0}
                decimalScale={2}
                fixedDecimalScale
                prefix={currencySymbol(currency)}
                value={form.values.compareAtPrice ?? ''}
                onChange={(value) =>
                  form.setFieldValue('compareAtPrice', value === '' ? null : Number(value))
                }
                error={form.errors.compareAtPrice}
              />
              <NumberInput
                label="Stock"
                required
                min={0}
                allowDecimal={false}
                {...form.getInputProps('stock')}
              />
            </Group>

            <Group gap="xl">
              <Switch
                label="Featured"
                description="Show in featured sections on the storefront"
                {...form.getInputProps('isFeatured', { type: 'checkbox' })}
              />
              <Switch
                label="Best seller"
                description="Show the best seller tag on the storefront"
                {...form.getInputProps('isBestSeller', { type: 'checkbox' })}
              />
            </Group>
          </Stack>
        </fieldset>

        {!readOnly && (
          <Group justify="flex-end" mt="lg">
            <Button type="submit" loading={submitting}>
              {submitLabel}
            </Button>
          </Group>
        )}
      </Paper>
    </form>
  )
}
