// No 0/O or 1/I/L: SKUs are read aloud and typed by hand.
const SUFFIX_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SUFFIX_LENGTH = 6

/** Random 6-character code (~887M combinations) from a cryptographic source. */
export function randomSkuSuffix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SUFFIX_LENGTH))
  return Array.from(bytes, (byte) => SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length]).join('')
}

/** First three letters/digits of the product name, e.g. "Classic T Shirt" → "CLA". */
function skuPrefix(name: string): string {
  const prefix = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3)
  return prefix.padEnd(3, 'X')
}

/**
 * Builds a SKU like `CLA-7K3M9P`: a readable name prefix plus a random suffix.
 * Uniqueness is enforced by the database; callers retry with a new suffix on a
 * conflict (collisions are astronomically unlikely, not impossible).
 */
export function buildSku(name: string, suffix: string = randomSkuSuffix()): string {
  return `${skuPrefix(name)}-${suffix}`
}
