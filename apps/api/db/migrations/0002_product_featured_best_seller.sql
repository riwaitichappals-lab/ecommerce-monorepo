-- =============================================================================
-- 0002_product_featured_best_seller
--
-- Adds manually managed merchandising flags to products:
--   is_featured     - shown in "featured" storefront sections
--   is_best_seller  - "best seller" tag
-- Both default to false, so existing rows and older API versions keep working.
-- Documented in docs/features/products/database.md.
-- =============================================================================

alter table products
  add column is_featured    boolean not null default false,
  add column is_best_seller boolean not null default false;

-- Partial indexes: only the (few) flagged rows are indexed.
create index products_featured_idx on products (created_at desc) where is_featured;
create index products_best_seller_idx on products (created_at desc) where is_best_seller;
