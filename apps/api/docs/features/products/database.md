# Products — Database

Migration: `db/migrations/0001_initial_schema.sql`. Rationale: [ADR 001](../../decisions/001-product-color-image-model.md).

```
categories 1 ── N products 1 ── N product_colors 1 ── N product_images
                    (restrict)        (cascade)             (cascade)
```

Why three levels: a color has its own data (name, hex, order) and its own gallery. Modelling it as a row gives integrity (unique names per product, cascade deletes, one primary image per color) and lets the storefront receive `product → colors → images` from one query.

## `products`

| Column | Type | Constraints / default | Notes |
| --- | --- | --- | --- |
| `id` | uuid | PK, `gen_random_uuid()` | |
| `name` | text | not null, length 1–200 | |
| `slug` | text | not null, **unique**, `^[a-z0-9]+(-[a-z0-9]+)*$` | storefront lookup key |
| `description` | text | not null, default `''` | |
| `price` | numeric(12,2) | not null, `> 0` | authoritative selling price |
| `compare_at_price` | numeric(12,2) | null, `> price` when set | "was" price |
| `sku` | text | not null, **unique**, length 1–100 | |
| `category_id` | uuid | FK → `categories.id` **ON DELETE RESTRICT**, null | |
| `status` | `product_status` | not null, default `draft` | `draft` \| `published` \| `archived` |
| `stock` | integer | not null, default 0, `>= 0` | decremented at checkout, restored on cancel |
| `is_featured` | boolean | not null, default false | manual "featured" flag; partial index `products_featured_idx` |
| `is_best_seller` | boolean | not null, default false | manual "best seller" tag; partial index `products_best_seller_idx` |
| `published_at` | timestamptz | null | set the first time the product is published |
| `created_at`, `updated_at` | timestamptz | not null, `now()`; `updated_at` via trigger | any color/image change also bumps the product's `updated_at` |

Indexes: `(category_id)`, `(status, updated_at desc)`, `(status, price)`, GIN trigram on `name` and `sku`.

## `product_colors`

| Column | Type | Constraints / default | Notes |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `product_id` | uuid | FK → `products.id` **ON DELETE CASCADE**, not null | a color belongs to exactly one product |
| `name` | text | not null, length 1–50; **unique per product, case-insensitive** (`product_colors_product_name_key` on `(product_id, lower(name))`) | |
| `hex_value` | text | not null, `^#([0-9A-F]{3}\|[0-9A-F]{6})$` (upper-case; the API normalises) | |
| `sort_order` | integer | not null, default 0 | display order |
| `created_at`, `updated_at` | timestamptz | | |

Index: `(product_id, sort_order)`.

## `product_images`

| Column | Type | Constraints / default | Notes |
| --- | --- | --- | --- |
| `id` | uuid | PK | |
| `product_color_id` | uuid | FK → `product_colors.id` **ON DELETE CASCADE**, not null | an image belongs to exactly one color |
| `image_url` | text | not null | canonical ImageKit URL (verified at registration) |
| `imagekit_file_id` | text | not null, **unique** | needed to delete the asset; never exposed publicly |
| `alt` | text | null | |
| `sort_order` | integer | not null, default 0 | |
| `is_primary` | boolean | not null, default false | **partial unique index** `product_images_one_primary_per_color (product_color_id) WHERE is_primary` |
| `created_at` | timestamptz | | |

Index: `(product_color_id, sort_order)`.

## Data ownership & behaviour

- The products module is the only writer of these three tables. Orders read `products`/`product_colors`/`product_images` at checkout (and lock `products` rows to decrement stock).
- **Cascade**: deleting a product deletes its colors, which deletes their images. Before deleting, the service collects every `imagekit_file_id` and inserts it into `pending_asset_deletions` in the same transaction ([image management](../../architecture/image-management.md#deletion-lifecycle)).
- `order_items.product_id` / `product_color_id` reference these rows with **ON DELETE SET NULL**. Orders keep their snapshot ([ADR 003](../../decisions/003-order-snapshots.md)).
- A category with products cannot be deleted (RESTRICT → 409).

## Transaction requirements

| Operation | Transaction contents |
| --- | --- |
| Create product | insert product → colors → images (any failure rolls back everything) |
| Update product | lock product `FOR UPDATE`; update fields; optional colors sync (delete removed, update kept, insert new, reset and reassign primaries); publish-rule check; enqueue removed files |
| Add/update/delete color or image | lock product `FOR UPDATE`; verify color ∈ product; mutate; maintain primary; bump product `updated_at`; enqueue removed files |
| Delete product | lock; collect file ids; delete; enqueue |

Image metadata is verified with ImageKit **before** the transaction starts. ImageKit deletions happen **after** commit.

## Queries

- **Detail** (`findById`, `findPublishedBySlug`): one statement; correlated `json_agg` subqueries build `colors[] → images[]` ordered by `sort_order, created_at`.
- **List**: page query (with primary image URL via a `LIMIT 1` subquery and swatches via `json_agg`) plus a `count(*)` with identical filters, run in parallel.
