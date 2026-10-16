import { useEffect, useState } from 'react'
import { Group, Select, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconSearch } from '@tabler/icons-react'
import { useProductFiltersStore } from '@/stores/list-filters.store'
import { useCategoryOptions } from '@/features/categories/hooks/use-categories'

const statusOptions = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
]

const sortOptions = [
  { value: 'updated-desc', label: 'Recently updated' },
  { value: 'created-desc', label: 'Newest' },
  { value: 'name-asc', label: 'Name (A–Z)' },
  { value: 'name-desc', label: 'Name (Z–A)' },
  { value: 'price-asc', label: 'Price (low to high)' },
  { value: 'price-desc', label: 'Price (high to low)' },
  { value: 'featured', label: 'Featured first' },
  { value: 'best-seller', label: 'Best sellers first' },
]

export function ProductFiltersBar() {
  const { search, status, categoryId, sort, setFilters } = useProductFiltersStore()
  const { data: categories } = useCategoryOptions()

  const [searchInput, setSearchInput] = useState(search)
  const [debouncedSearch] = useDebouncedValue(searchInput, 300)

  useEffect(() => {
    // Skip the initial mount (and unrelated renders): resetting to page 1 on every
    // mount would lose the page the user was on when returning from a detail view.
    if (debouncedSearch !== search) setFilters({ search: debouncedSearch })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch])

  const categoryOptions = [
    { value: 'all', label: 'All categories' },
    ...(categories ?? []).map((c) => ({ value: c.id, label: c.name })),
  ]

  return (
    <Group mb="md" wrap="wrap">
      <TextInput
        placeholder="Search by name or SKU…"
        leftSection={<IconSearch size={16} />}
        value={searchInput}
        onChange={(e) => setSearchInput(e.currentTarget.value)}
        w={260}
      />
      <Select
        data={statusOptions}
        value={status}
        onChange={(value) => setFilters({ status: (value ?? 'all') as typeof status })}
        w={170}
        allowDeselect={false}
      />
      <Select
        data={categoryOptions}
        value={categoryId ?? 'all'}
        onChange={(value) => setFilters({ categoryId: value ?? 'all' })}
        w={190}
        searchable
        allowDeselect={false}
      />
      <Select
        data={sortOptions}
        value={sort}
        onChange={(value) => setFilters({ sort: (value ?? 'updated-desc') as typeof sort })}
        w={190}
        allowDeselect={false}
      />
    </Group>
  )
}
