import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, Anchor, Button, Center, Loader, Paper, Tabs, Text, Title, Tooltip } from '@mantine/core'
import { IconInfoCircle, IconRocket } from '@tabler/icons-react'
import { PageHeader } from '@/components/page-header'
import { ErrorState } from '@/components/feedback/error-state'
import { ProductStatusBadge } from '@/components/status-badge'
import { useCanWriteCatalog } from '@/features/auth/hooks/use-can-write'
import { ColorManager } from '@/features/products/components/color-manager'
import { ProductForm } from '@/features/products/components/product-form'
import { useProduct } from '@/features/products/hooks/use-product'
import {
  useCreateProduct,
  useSetProductStatus,
  useUpdateProduct,
} from '@/features/products/hooks/use-product-mutations'
import type { ProductFormValues } from '@/schemas/product.schema'

export function ProductEditPage() {
  const { id } = useParams<{ id: string }>()
  const isNew = id === 'new'
  const navigate = useNavigate()
  const canWrite = useCanWriteCatalog()

  const productQuery = useProduct(isNew ? undefined : id)
  const createProduct = useCreateProduct()
  const updateProduct = useUpdateProduct(id ?? '')
  const setStatus = useSetProductStatus()
  const [tab, setTab] = useState<string | null>('details')

  if (!isNew && productQuery.isLoading) {
    return (
      <Center h={300}>
        <Loader />
      </Center>
    )
  }

  if (!isNew && (productQuery.isError || !productQuery.data)) {
    return (
      <ErrorState
        error={productQuery.error}
        onRetry={() => void productQuery.refetch()}
        title="Could not load product"
      />
    )
  }

  if (isNew && !canWrite) {
    return (
      <ErrorState
        error={new Error('You need the admin role to create products.')}
        title="Not allowed"
      />
    )
  }

  const product = productQuery.data

  const handleSubmit = async (values: ProductFormValues) => {
    if (isNew) {
      // Colors and images are added on the next screen, where every change is saved immediately.
      const created = await createProduct.mutateAsync(values)
      // Same route element, so the tab state survives the navigation: open the next step.
      setTab('colors')
      navigate(`/products/${created.id}`, { replace: true })
    } else {
      await updateProduct.mutateAsync(values)
    }
  }

  // Mirrors the API publish rule: at least one color, and every color has an image.
  const publishable = Boolean(product?.colors.length) && product!.colors.every((c) => c.images.length > 0)
  const canPublish = Boolean(product) && canWrite && product!.status !== 'published'

  return (
    <>
      <PageHeader
        title={isNew ? 'New product' : product?.name || 'Edit product'}
        description={isNew ? 'Create a new catalog item' : `SKU ${product?.sku}`}
        actions={
          <>
            {product && <ProductStatusBadge status={product.status} />}
            {canPublish && (
              <Tooltip
                label="Add at least one color, each with an image, to publish"
                disabled={publishable}
              >
                <span>
                  <Button
                    size="xs"
                    leftSection={<IconRocket size={14} />}
                    disabled={!publishable}
                    loading={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: product!.id, status: 'published' })}
                  >
                    Publish item
                  </Button>
                </span>
              </Tooltip>
            )}
            <Anchor component={Link} to="/products" size="sm">
              ← All products
            </Anchor>
          </>
        }
      />

      {!canWrite && (
        <Text size="sm" c="dimmed" mb="md">
          You have read-only access. The admin role is required to change products.
        </Text>
      )}

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="details">Details</Tabs.Tab>
          <Tabs.Tab value="colors" disabled={isNew}>
            Colors &amp; images
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="details" pt="md">
          {isNew && (
            <Alert icon={<IconInfoCircle size={16} />} mb="md" variant="light">
              Save the product first, then add its colors and images.
            </Alert>
          )}
          <ProductForm
            product={isNew ? undefined : product}
            onSubmit={handleSubmit}
            submitting={isNew ? createProduct.isPending : updateProduct.isPending}
            submitLabel={isNew ? 'Create product' : 'Save changes'}
            readOnly={!canWrite}
          />
        </Tabs.Panel>

        <Tabs.Panel value="colors" pt="md">
          {product && (
            <Paper withBorder radius="md" p="lg">
              <Title order={5} mb="xs">
                Colors &amp; images
              </Title>
              <ColorManager product={product} readOnly={!canWrite} />
            </Paper>
          )}
        </Tabs.Panel>
      </Tabs>
    </>
  )
}
