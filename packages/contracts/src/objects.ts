/**
 * Typed `Object.keys` and friends, for the literal objects the contracts are built from
 * (a catalog, a map of plans). `Object.keys` says `string[]`, because an object may have
 * more keys than its type names; these check each key at runtime instead of casting.
 */

/** Whether `key` is one of the object's own keys. */
export function hasKey<T extends object>(object: T, key: PropertyKey): key is keyof T {
  return Object.hasOwn(object, key);
}

/** The object's own keys, typed as its keys. */
export function keysOf<T extends object>(object: T): (keyof T & string)[] {
  return Object.keys(object).filter((key): key is keyof T & string => hasKey(object, key));
}

/** The object's own entries, typed by its keys. */
export function entriesOf<T extends object>(object: T): [keyof T & string, T[keyof T & string]][] {
  return keysOf(object).map((key) => [key, object[key]]);
}
