// Pure `_cf_link` column-name helpers, shared by the server (this package) and
// the client-side codec (runner). No runtime/FFI dependencies.

export const CF_LINK_SUFFIX = "_cf_link";

/** A column/parameter is a link column iff its name ends in `_cf_link` (with a
 *  non-empty prefix). */
export function isCfLinkColumn(name: string): boolean {
  return name.length > CF_LINK_SUFFIX.length && name.endsWith(CF_LINK_SUFFIX);
}
