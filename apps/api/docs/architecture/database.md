# Database

Supabase Postgres. The schema source of truth is [`db/migrations/`](../../db/migrations). Per-feature details (columns, constraints, business meaning) are in each feature's `database.md`; this page is the map.

## Entity relationships

```
auth.users (Supabase) ─1:0..1─ admin_profiles
auth.users (Supabase) ─1:0..1─ customers.auth_user_id   (reserved; unused today)

categories ─1:N─ products ─1:N─ product_colors ─1:N─ product_images
                     │                 │
                     │ (set null)      │ (set null)
                     ▼                 ▼
customers ─1:N─ orders ─1:N─ order_items      (purchase-time snapshot columns)
    │              └─1:N─ order_status_history ─N:1─ admin_profiles (changed_by, set null)
    └─1:N─ addresses

pending_asset_deletions   (ImageKit deletion outbox; no FKs)
schema_migrations         (migration bookkeeping)
```

| Table | Owner module | Docs |
| --- | --- | --- |
| `admin_profiles` | auth | [features/auth/database.md](../features/auth/database.md) |
| `categories` | categories | [features/categories/database.md](../features/categories/database.md) |
| `products`, `product_colors`, `product_images` | products | [features/products/database.md](../features/products/database.md) |
| `pending_asset_deletions` | uploads | [image-management.md](./image-management.md) |
| `customers`, `addresses` | customers (written by orders checkout) | [features/customers/database.md](../features/customers/database.md) |
| `orders`, `order_items`, `order_status_history` | orders | [features/orders/database.md](../features/orders/database.md) |

## Delete behaviour (cascade rules)

| Deleting… | Effect |
| --- | --- |
| a product | its colors and images cascade; `order_items.product_id` → `NULL` (the snapshot stays); image files are queued for ImageKit deletion |
| a color | its images cascade; `order_items.product_color_id` → `NULL` |
| a category | **blocked** (`ON DELETE RESTRICT`) while any product uses it → 409 |
| a customer | their orders keep all data; `orders.customer_id` → `NULL` |
| an order | its items and history cascade (no API does this) |
| a Supabase auth user | their `admin_profiles` row cascades; `customers.auth_user_id` → `NULL` |
| an admin profile | `order_status_history.changed_by` → `NULL` |

## Conventions

- Primary keys are `uuid` (`gen_random_uuid()`), except `admin_profiles.id`, which equals `auth.users.id`.
- Timestamps are `timestamptz`. `created_at` defaults to `now()`, and `updated_at` is maintained by the `set_updated_at()` trigger.
- Money is `numeric(12,2)`. The API returns JSON numbers, and service arithmetic is done in integer cents (`src/lib/money.ts`).
- Enums: `admin_role`, `product_status`, `order_status`, `payment_status`.
- Slugs are checked with `^[a-z0-9]+(-[a-z0-9]+)*$`. Hex colors are stored upper-case, `#RGB` or `#RRGGBB`.
- Case-insensitive uniqueness uses expression indexes (`lower(email)`, `lower(name)`).
- Text search uses `ILIKE` backed by `pg_trgm` GIN indexes (the extension lives in the `extensions` schema).

## Access & permissions

The API connects with `DATABASE_URL` as a privileged Postgres role (the Supabase `postgres` user), which bypasses RLS. Migration `0001` then:

- enables RLS on every table **with no policies**, and
- revokes all privileges from Supabase's `anon` and `authenticated` roles.

So even with the public anon key and a valid user session, PostgREST (`supabase.from('products')…`) returns *permission denied*. This is deliberate ([ADR 002](../decisions/002-data-access-through-api-only.md)); **every new table must get the same treatment** (see [contributing.md](../development/contributing.md#migrations)).

## Transactions & concurrency

Services own transactions (`db.transaction(async (tx) => …)`). Multi-row writes always run in one:

| Operation | Locking |
| --- | --- |
| Product update, color/image add/update/delete | `SELECT … FOR UPDATE` on the product row serialises concurrent edits of one product, so primary-image and publish rules cannot race |
| Checkout | `FOR UPDATE` on every product in the cart, locked in id order to avoid deadlocks. Stock check, decrement, and order insert happen atomically |
| Order status change | `FOR UPDATE` on the order. Status update, history row, and restock (on cancel) are atomic |
| Asset cleanup | `FOR UPDATE SKIP LOCKED` + a lease, so several API instances never process the same row |

Network calls (ImageKit verification and deletion) are **never** made while a transaction holds locks.

## Connection handling

- postgres.js pool, `DATABASE_POOL_MAX` connections (default 10) per instance. It is reused for the process lifetime and closed on shutdown.
- `prepare: false`, so it works with Supabase's **transaction pooler** (port 6543), which is recommended for the server. Migrations should use the session pooler or a direct connection (port 5432).
- Column names are mapped snake_case ⇄ camelCase automatically.

## Indexes (why each exists)

| Index | Serves |
| --- | --- |
| `products (status, updated_at desc)`, `(status, price)` | storefront/admin lists filtered by status, sorted by recency or price |
| `products (category_id)` | category filter; the RESTRICT check on category delete |
| `products` GIN trigram on `name`, `sku` | `search=` |
| `product_colors (product_id, sort_order)`, `product_images (product_color_id, sort_order)` | the nested product query (colors → images, ordered) |
| `product_images` partial unique `(product_color_id) WHERE is_primary` | at most one primary image per color |
| `orders (created_at desc)`, `(status, created_at desc)`, `(customer_id, created_at desc)`, `(payment_status)` | admin order lists, filters, dashboard aggregates |
| `orders` GIN trigram on `customer_email`, `customer_name` | order search |
| `order_items (order_id)`, `order_status_history (order_id, created_at)` | order detail |
| `customers` unique `lower(email)` + trigram on name/email | checkout find-or-create; customer search |
| `pending_asset_deletions (next_attempt_at)` | cleanup job |

## Migrations

| Migration | Summary |
| --- | --- |
| `0001_initial_schema.sql` | All tables, enums, triggers, indexes, RLS lockdown |
| `0002_product_featured_best_seller.sql` | `products.is_featured`, `products.is_best_seller` + partial indexes |

Run with `npm run db:migrate` (`-- --status` to list). Migration rules: [contributing.md](../development/contributing.md#migrations).
