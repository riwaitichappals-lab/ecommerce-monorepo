import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ActionIcon, Avatar, Badge, ColorSwatch, Group, Menu, Table, Text } from '@mantine/core'
import {
  IconArchive,
  IconDots,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconPhoto,
  IconTrash,
} from '@tabler/icons-react'
import { EmptyState } from '@/components/feedback/empty-state'
import { ConfirmDialog } from '@/components/feedback/confirm-dialog'
import { ProductStatusBadge } from '@/components/status-badge'
import { TableSkeleton } from '@/components/table-skeleton'
import { formatCurrency, formatNumber } from '@/lib/format'
import { useCanWriteCatalog } from '@/features/auth/hooks/use-can-write'
import { useCurrency } from '@/features/dashboard/hooks/use-currency'
import { useDeleteProduct, useSetProductStatus } from '@/features/products/hooks/use-product-mutations'
import type { ProductListItem } from '@/types/api'

interface ProductsTableProps {
  products: ProductListItem[]
  loading: boolean
}

export function ProductsTable({ products, loading }: ProductsTableProps) {
  const [pendingDelete, setPendingDelete] = useState<ProductListItem | null>(null)
  const canWrite = useCanWriteCatalog()
  const currency = useCurrency()
  const deleteProduct = useDeleteProduct()
  const setStatus = useSetProductStatus()

  if (!loading && products.length === 0) {
    return (
      <EmptyState
        icon={<IconPhoto size={24} />}
        title="No products found"
        description="Try adjusting your filters, or create a new product to get started."
      />
    )
  }

  return (
    <>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Product</Table.Th>
            <Table.Th>SKU</Table.Th>
            <Table.Th>Category</Table.Th>
            <Table.Th>Price</Table.Th>
            <Table.Th>Stock</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {loading ? (
            <TableSkeleton columns={7} rows={8} />
          ) : (
            products.map((product) => (
              <Table.Tr key={product.id}>
                <Table.Td>
                  <Link
                    to={`/products/${product.id}`}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <Group gap="sm" wrap="nowrap">
                      <Avatar src={product.primaryImageUrl} radius="sm" size={36}>
                        <IconPhoto size={16} />
                      </Avatar>
                      <div>
                        <Text size="sm" fw={500}>
                          {product.name}
                        </Text>
                        <Group gap={4} mt={2}>
                          {product.colors.slice(0, 6).map((color) => (
                            <ColorSwatch
                              key={color.id}
                              color={color.hexValue}
                              size={12}
                              title={color.name}
                            />
                          ))}
                          <Text size="xs" c="dimmed">
                            {product.colorCount} color{product.colorCount === 1 ? '' : 's'}
                          </Text>
                        </Group>
                      </div>
                    </Group>
                  </Link>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" ff="monospace">
                    {product.sku}
                  </Text>
                </Table.Td>
                <Table.Td>{product.category?.name ?? '—'}</Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    <Text size="sm">{formatCurrency(product.price, currency)}</Text>
                    {product.compareAtPrice && (
                      <Text size="xs" c="dimmed" td="line-through">
                        {formatCurrency(product.compareAtPrice, currency)}
                      </Text>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c={product.stock === 0 ? 'red' : undefined}>
                    {formatNumber(product.stock)}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4}>
                    <ProductStatusBadge status={product.status} />
                    {product.isFeatured && (
                      <Badge variant="light" color="violet">
                        Featured
                      </Badge>
                    )}
                    {product.isBestSeller && (
                      <Badge variant="light" color="orange">
                        Best seller
                      </Badge>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>
                  <Menu shadow="md" position="bottom-end" width={190}>
                    <Menu.Target>
                      <ActionIcon variant="subtle" color="gray" aria-label="Product actions">
                        <IconDots size={16} />
                      </ActionIcon>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        component={Link}
                        to={`/products/${product.id}`}
                        leftSection={<IconEdit size={14} />}
                      >
                        {canWrite ? 'Edit' : 'View'}
                      </Menu.Item>
                      {canWrite && (
                        <>
                          {product.status === 'published' ? (
                            <Menu.Item
                              leftSection={<IconEyeOff size={14} />}
                              onClick={() => setStatus.mutate({ id: product.id, status: 'draft' })}
                            >
                              Unpublish
                            </Menu.Item>
                          ) : (
                            <Menu.Item
                              leftSection={<IconEye size={14} />}
                              onClick={() =>
                                setStatus.mutate({ id: product.id, status: 'published' })
                              }
                            >
                              Publish
                            </Menu.Item>
                          )}
                          {product.status !== 'archived' && (
                            <Menu.Item
                              leftSection={<IconArchive size={14} />}
                              onClick={() =>
                                setStatus.mutate({ id: product.id, status: 'archived' })
                              }
                            >
                              Archive
                            </Menu.Item>
                          )}
                          <Menu.Divider />
                          <Menu.Item
                            color="red"
                            leftSection={<IconTrash size={14} />}
                            onClick={() => setPendingDelete(product)}
                          >
                            Delete
                          </Menu.Item>
                        </>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                </Table.Td>
              </Table.Tr>
            ))
          )}
        </Table.Tbody>
      </Table>

      <ConfirmDialog
        opened={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            deleteProduct.mutate(pendingDelete.id, {
              onSettled: () => setPendingDelete(null),
            })
          }
        }}
        title="Delete product"
        message={`Delete "${pendingDelete?.name}" with all of its colors and images? Existing orders keep their purchase-time details. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        loading={deleteProduct.isPending}
      />
    </>
  )
}
