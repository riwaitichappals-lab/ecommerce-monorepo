# Products API

Conventions (envelopes, errors, pagination): [api-architecture.md](../../architecture/api-architecture.md). All request bodies are JSON. Money values are numbers with ≤ 2 decimals.

| Method | Path | Auth |
| --- | --- | --- |
| GET | [`/api/store/products`](#get-apistoreproducts) | public |
| GET | [`/api/store/products/:slug`](#get-apistoreproductsslug) | public |
| GET | [`/api/products`](#get-apiproducts) | admin (staff+) |
| GET | [`/api/products/:id`](#get-apiproductsid) | admin (staff+) |
| POST | [`/api/admin/products`](#post-apiadminproducts) | admin (admin+) |
| PATCH | [`/api/admin/products/:id`](#patch-apiadminproductsid) | admin (admin+) |
| DELETE | [`/api/admin/products/:id`](#delete-apiadminproductsid) | admin (admin+) |
| POST | [`/api/admin/products/:id/colors`](#post-apiadminproductsidcolors) | admin (admin+) |
| PATCH | [`/api/admin/products/:id/colors/:colorId`](#patch-apiadminproductsidcolorscolorid) | admin (admin+) |
| DELETE | [`/api/admin/products/:id/colors/:colorId`](#delete-apiadminproductsidcolorscolorid) | admin (admin+) |
| POST | [`/api/admin/products/:id/colors/:colorId/images`](#images) | admin (admin+) |
| PATCH | [`/api/admin/products/:id/colors/:colorId/images/:imageId`](#images) | admin (admin+) |
| DELETE | [`/api/admin/products/:id/colors/:colorId/images/:imageId`](#images) | admin (admin+) |

---

## Storefront

### GET /api/store/products

Published products, paginated. Cacheable (`Cache-Control: public, max-age=60…`).

Query:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | int ≥ 1 | 1 | |
| `pageSize` | int 1–100 | 20 | |
| `search` | string ≤ 200 | — | name or SKU, case-insensitive substring |
| `category` | slug | — | active category slug |
| `minPrice`, `maxPrice` | number ≥ 0 | — | inclusive; `minPrice ≤ maxPrice` |
| `featured` | `true` \| `false` | — | only featured / only non-featured products |
| `sort` | `newest` \| `price-asc` \| `price-desc` \| `name-asc` \| `featured` \| `best-seller` | `newest` | `featured` and `best-seller` put flagged products first (newest first within each group) |

Response `200`:

```json
{
  "data": [
    {
      "id": "3f0c…",
      "slug": "classic-t-shirt",
      "name": "Classic T Shirt",
      "price": 19.99,
      "compareAtPrice": 24.99,
      "currency": "USD",
      "inStock": true,
      "category": { "name": "T-Shirts", "slug": "t-shirts" },
      "imageUrl": "https://ik.imagekit.io/acme/products/black-2.jpg",
      "thumbUrl": "https://ik.imagekit.io/acme/products/black-2.jpg?tr=w-400,h-400,c-at_max",
      "colors": [
        { "id": "a1…", "name": "Black", "hexValue": "#000000" },
        { "id": "b2…", "name": "White", "hexValue": "#FFFFFF" }
      ]
    }
  ],
  "pagination": { "page": 1, "pageSize": 20, "total": 1, "totalPages": 1 }
}
```

`imageUrl` is the primary image of the first color. `colors` are swatches only.

### GET /api/store/products/:slug

One published product with **every color and every image**, so the storefront can switch colors without further requests ([ADR 001](../../decisions/001-product-color-image-model.md)).

Response `200`:

```json
{
  "data": {
    "id": "3f0c…",
    "slug": "classic-t-shirt",
    "name": "Classic T Shirt",
    "description": "Soft cotton",
    "price": 19.99,
    "compareAtPrice": 24.99,
    "currency": "USD",
    "sku": "TSHIRT-001",
    "inStock": true,
    "category": { "name": "T-Shirts", "slug": "t-shirts" },
    "colors": [
      {
        "id": "a1…",
        "name": "Black",
        "hexValue": "#000000",
        "images": [
          { "id": "i1…", "url": "https://ik.imagekit.io/acme/products/black-1.jpg", "thumbUrl": "…?tr=w-400,h-400,c-at_max", "alt": "Front", "sortOrder": 0, "isPrimary": false },
          { "id": "i2…", "url": "https://ik.imagekit.io/acme/products/black-2.jpg", "thumbUrl": "…", "alt": null, "sortOrder": 1, "isPrimary": true }
        ]
      },
      { "id": "b2…", "name": "White", "hexValue": "#FFFFFF", "images": [ … ] }
    ]
  }
}
```

Colors and images are ordered by `sortOrder`. Every storefront product and list item also carries `isFeatured` and `isBestSeller` booleans (the "best seller" tag). Not exposed: status, stock count, ImageKit file ids, internal category id, timestamps.

Errors: `404 NOT_FOUND` if the slug doesn't exist or the product isn't published; `422` if the slug is malformed.

---

## Admin reads

### GET /api/products

All products (any status). `Cache-Control: no-store`.

Query: `page`, `pageSize`, `search` (name/SKU), `status` (`draft|published|archived`), `categoryId` (uuid), `featured` (`true|false`), `sort` (`updated-desc` default | `created-desc` | `name-asc` | `name-desc` | `price-asc` | `price-desc` | `featured` | `best-seller`). List items and product details include `isFeatured` and `isBestSeller`.

Response `200` item:

```json
{
  "id": "3f0c…", "name": "Classic T Shirt", "slug": "classic-t-shirt", "sku": "TSHIRT-001",
  "status": "published", "price": 19.99, "compareAtPrice": 24.99, "stock": 5,
  "category": { "id": "c0…", "name": "T-Shirts", "slug": "t-shirts" },
  "primaryImageUrl": "https://ik.imagekit.io/…", "colorCount": 2,
  "colors": [ { "id": "a1…", "name": "Black", "hexValue": "#000000" } ],
  "createdAt": "2026-09-23T10:00:00.000Z", "updatedAt": "2026-09-23T10:05:00.000Z"
}
```

### GET /api/products/:id

Full admin product (the response of every product write endpoint):

```json
{
  "data": {
    "id": "3f0c…", "name": "Classic T Shirt", "slug": "classic-t-shirt", "description": "Soft cotton",
    "price": 19.99, "compareAtPrice": 24.99, "sku": "TSHIRT-001",
    "categoryId": "c0…", "category": { "id": "c0…", "name": "T-Shirts", "slug": "t-shirts" },
    "status": "published", "stock": 5, "publishedAt": "2026-09-23T10:05:00.000Z",
    "createdAt": "…", "updatedAt": "…",
    "colors": [
      {
        "id": "a1…", "name": "Black", "hexValue": "#000000", "sortOrder": 0, "primaryImageId": "i2…",
        "images": [
          { "id": "i2…", "imageUrl": "https://ik.imagekit.io/…", "thumbUrl": "…", "imageKitFileId": "65f…", "alt": null, "sortOrder": 0, "isPrimary": true }
        ]
      }
    ]
  }
}
```

Errors: `401`, `403`, `404`, `422` (bad uuid).

---

## Admin writes

Common errors for all writes: `401`, `403` (role below `admin`), `404` (product/color/image), `422` (validation or business rule), `409` (conflict), `502` (ImageKit unreachable during image verification).

### Image metadata object (`NewImage`)

Sent after the browser uploads to ImageKit ([upload lifecycle](../../architecture/image-management.md#upload-lifecycle)):

| Field | Type | Rules |
| --- | --- | --- |
| `imageUrl` | string | `https` URL, ≤ 2048 chars, must start with `IMAGEKIT_URL_ENDPOINT`; must match the file in ImageKit |
| `imageKitFileId` | string | 1–100 chars, must exist in ImageKit, unique across all images |
| `alt` | string \| null | ≤ 250 |
| `sortOrder` | int 0–10000 | default: position in array (bulk) or next (single add) |
| `isPrimary` | boolean | at most one image becomes primary; default first image |

### POST /api/admin/products

Creates a product, optionally with colors and images, in **one transaction** (nothing is created if any part fails).

Body:

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `name` | string | ✓ | 1–200, trimmed |
| `slug` | string | ✓ | `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤ 200, unique |
| `description` | string | | ≤ 10000, default `""` |
| `price` | number | ✓ | > 0, ≤ 2 decimals |
| `compareAtPrice` | number \| null | | > `price`, default null |
| `sku` | string | ✓ | 1–100, unique |
| `categoryId` | uuid \| null | | must exist |
| `status` | `draft` \| `published` \| `archived` | | default `draft`; `published` requires colors with images |
| `stock` | int | | 0–1,000,000, default 0 |
| `isFeatured` | boolean | | default `false`; also accepted by `PATCH` |
| `isBestSeller` | boolean | | default `false`; "best seller" tag, also accepted by `PATCH` |
| `colors` | array ≤ 30 | | `{ name (1–50, unique per product), hexValue, sortOrder?, images: NewImage[] ≤ 20 }` |

```json
{
  "name": "Classic T Shirt",
  "slug": "classic-t-shirt",
  "price": 19.99,
  "compareAtPrice": 24.99,
  "sku": "TSHIRT-001",
  "categoryId": "c0…",
  "stock": 5,
  "colors": [
    { "name": "Black", "hexValue": "#000000", "images": [ { "imageUrl": "https://ik.imagekit.io/acme/products/black-1.jpg", "imageKitFileId": "65f…" } ] }
  ]
}
```

Response `201` + `Location: /api/products/:id`, body = admin product.

Specific errors: `409` duplicate slug / SKU / ImageKit file; `422 BUSINESS_RULE_VIOLATION` unknown category, publish rule, compareAtPrice; `422 INVALID_IMAGE`.

### PATCH /api/admin/products/:id

Partial update: send only the fields to change (at least one). Same field rules as create.

**`colors` (optional) replaces the whole color/image set** (the admin product form's "save"):

- a color **with** `id` is updated (it must belong to this product); **without** `id` it is created
- existing colors **not** in the array are deleted (with their images)
- within a color, images are either `{ id, alt?, sortOrder?, isPrimary? }` (keep/update; must belong to that color) or a `NewImage` (create); existing images not listed are deleted
- array position is the default `sortOrder`
- removed images' ImageKit files are deleted after commit (queued on failure)

```json
{
  "status": "published",
  "colors": [
    { "id": "a1…", "name": "Jet Black", "hexValue": "#111111",
      "images": [ { "id": "i2…", "isPrimary": true }, { "imageUrl": "https://ik.imagekit.io/acme/products/black-3.jpg", "imageKitFileId": "66a…" } ] },
    { "name": "Red", "hexValue": "#FF0000", "images": [ { "imageUrl": "…", "imageKitFileId": "66b…" } ] }
  ]
}
```

Response `200`: admin product. Omitting `colors` leaves colors untouched. Setting `compareAtPrice: null` clears it.

### DELETE /api/admin/products/:id

Deletes the product, its colors, and images. Queues the ImageKit files for deletion. Order history is preserved. Response `204`. `404` if the product doesn't exist.

### POST /api/admin/products/:id/colors

Body: `{ name, hexValue, sortOrder?, images?: NewImage[] }`. `sortOrder` defaults to after the last color. If the product is published, `images` must be non-empty.
Response `201`: `{ data: AdminColor }` (`id, name, hexValue, sortOrder, primaryImageId, images[]`).

### PATCH /api/admin/products/:id/colors/:colorId

Body: any of `{ name, hexValue, sortOrder }` (at least one). Response `200`: `{ data: AdminColor }`. `404` if the color doesn't belong to the product; `409` duplicate name.

### DELETE /api/admin/products/:id/colors/:colorId

Deletes the color and its images; queues ImageKit files. Response `204`. `422` if it is the last color of a published product.

### Images

**POST `/api/admin/products/:id/colors/:colorId/images`**: attach an uploaded image. Body: `NewImage`. The first image of a color becomes primary; `isPrimary: true` makes this image the only primary. Response `201`:

```json
{ "data": { "id": "i3…", "imageUrl": "https://ik.imagekit.io/…", "thumbUrl": "…", "imageKitFileId": "66a…", "alt": "Back", "sortOrder": 1, "isPrimary": true } }
```

Errors: `422 INVALID_IMAGE` (wrong endpoint, file missing in ImageKit, URL/file mismatch), `409` file already attached, `502` ImageKit unreachable.

**PATCH `/api/admin/products/:id/colors/:colorId/images/:imageId`**: body any of `{ alt, sortOrder, isPrimary }`. `isPrimary: true` makes it the only primary; `isPrimary: false` on the primary promotes the first image by sort order. Response `200`: image.

**DELETE `/api/admin/products/:id/colors/:colorId/images/:imageId`**: response `204`. **Idempotent**: an already-deleted image also returns `204` (the product and color must exist, otherwise `404`). Deleting the primary promotes the next image. `422` if it is the last image of a color on a published product. The ImageKit file is deleted after the DB commit, and a failure is queued for retry without failing the request ([details](../../architecture/image-management.md#deletion-lifecycle)).
