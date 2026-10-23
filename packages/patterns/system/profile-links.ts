/**
 * Reading Home's profile links as links: a profile is identified by its own
 * space, which a link names without the profile's document being loaded. A
 * module of its own, so that Home's handlers outside the profile patterns
 * compare profiles as `#profile` compares them.
 */

// Read a profile link (or list of links) as cell REFERENCES (`asCell`), not
// inlined values. A plain `.get()` deep-resolves each element and collapses the
// whole read to `undefined` when any element links into a space not yet loaded
// in this context (e.g. a freshly-created profile living in its own `inSpace`
// space). Item type is `unknown` to keep the sync shallow (links only). Mirrors
// wish.ts `profileLinkListSchema`; identity comparisons use `equals` on the
// resulting link cells, which never deep-resolves.
//
// These are functions (not const object literals) so the schema object is built
// per call inside the function body — module-top-level mutable data is rejected
// under SES (`__cf_data()`); a function returning a fresh literal is not.
// deno-lint-ignore no-explicit-any
export const profileLinkListSchema = (): any => ({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
});
// deno-lint-ignore no-explicit-any
export const profileLinkSchema = (): any => ({
  type: "unknown",
  asCell: ["cell"],
});

/**
 * The space `cell` lives in: for a profile link, the profile's own space,
 * which is what identifies a profile. `undefined` when `cell` is not a
 * resolvable link. The pattern-facing `Cell` has no typed space accessor, so
 * the link is read through `any`.
 */
export const profileLinkSpace = (cell: unknown): string | undefined => {
  try {
    // deno-lint-ignore no-explicit-any
    return (cell as any)?.getAsNormalizedFullLink?.()?.space;
  } catch {
    return undefined;
  }
};

/**
 * The links the profile list `list` holds, read as link cells
 * (`profileLinkListSchema()`).
 */
export const profileLinks = (list: unknown): unknown[] =>
  // deno-lint-ignore no-explicit-any
  (list as any).asSchema(profileLinkListSchema()).get() ?? [];
