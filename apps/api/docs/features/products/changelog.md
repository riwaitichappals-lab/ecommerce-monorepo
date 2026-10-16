# Products Changelog

## 2026-10-15

### Added

- `products.is_featured` and `products.is_best_seller` boolean flags (migration `0002_product_featured_best_seller`, default `false`).
- `isFeatured` / `isBestSeller` accepted on `POST /api/admin/products` and `PATCH /api/admin/products/:id`, and returned on admin and storefront product responses (list and detail).
- `sort=featured` and `sort=best-seller` on `GET /api/products` and `GET /api/store/products` (flagged products first, newest first within each group).
- `featured=true|false` filter on both list endpoints.

### Frontend impact

- Non-breaking: new optional request fields and new response fields. Run migration `0002` before deploying the API.

## 2026-09-23

### Added

- Tables `products`, `product_colors`, `product_images` (migration `0001_initial_schema`).
- Admin reads: `GET /api/products`, `GET /api/products/:id` (pagination, search, category/status filters, sorting).
- Admin writes: `POST/PATCH/DELETE /api/admin/products[/:id]`, color endpoints (`POST/PATCH/DELETE …/colors[/:colorId]`), image endpoints (`POST …/images`, `PATCH/DELETE …/images/:imageId`).
- Storefront: `GET /api/store/products`, `GET /api/store/products/:slug`.
- Nested product creation (colors + images) in one transaction; full color/image sync through `PATCH … { colors }`.
- Publish rule (≥ 1 color, ≥ 1 image per color) and single-primary-image rule.
- ImageKit metadata verification on image registration; ImageKit asset cleanup through the `pending_asset_deletions` outbox.

### Technical Notes

- Color and image data is returned inside the initial product response (one SQL query with nested `json_agg`) so the storefront switches colors with no extra requests ([ADR 001](../../decisions/001-product-color-image-model.md)).
- `PATCH /api/admin/products/:id/colors/:colorId/images/:imageId` was added beyond the original endpoint list so the dashboard can change alt text, order, and the primary image without a full sync.
- Storefront DTOs are separate schemas; ImageKit file ids, stock counts, and status are never exposed publicly.

### Developer Notes

- The storefront must not call the API on color change. Switch images client-side from the loaded `colors[].images[]` and preload other colors' images after first paint.
- The admin dashboard's current API client uses different paths and field names; see [integration notes](../../architecture/api-architecture.md#admin-dashboard-integration-notes).

### Migration / Compatibility

- New tables; no backward-compatibility concerns.
