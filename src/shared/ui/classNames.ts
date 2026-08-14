/**
 * classNames — the one way a class list is assembled in this product.
 *
 * `noUncheckedIndexedAccess` types a CSS Modules index lookup as
 * `string | undefined`, and `exactOptionalPropertyTypes` then refuses it for an
 * optional `className` — the value is never missing at runtime, only the type is
 * being cautious; this returns a definite string. Falsy values are dropped
 * rather than stringified, so a class list never ships "false"/"undefined" to
 * the DOM. Deliberately not a `clsx` clone: no nested arrays, no object syntax,
 * no dependency.
 */
export type ClassNameInput = string | false | null | undefined;

/** Joins the truthy class names with a single space. */
export function classNames(...names: readonly ClassNameInput[]): string {
  let out = '';
  for (const name of names) {
    if (name === undefined || name === null || name === false || name === '') continue;
    out = out === '' ? name : `${out} ${name}`;
  }
  return out;
}

export default classNames;
