/**
 * Shopify grants implied read access with every write scope: an app holding
 * write_themes can read themes even if read_themes is not in the token's
 * scope string. https://shopify.dev/docs/api/usage/access-scopes
 */
export function scopeSatisfied(required: string, granted: string[]): boolean {
  if (granted.includes(required)) return true;
  if (required.startsWith('read_')) return granted.includes(`write_${required.slice(5)}`);
  return false;
}

export function missingScopes(required: string[], granted: string[]): string[] {
  return required.filter((r) => !scopeSatisfied(r, granted));
}
