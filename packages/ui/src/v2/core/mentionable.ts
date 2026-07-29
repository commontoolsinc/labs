import { type JSONSchema, NAME } from "@commonfabric/runner/shared";

export interface Mentionable {
  [NAME]: string;
  [key: string]: unknown;
}

// A slot may be null: a member whose pattern can't load on this runtime can't
// satisfy MentionableSchema, and the array read degrades it to `null` rather
// than voiding every sibling (see MentionableArraySchema). Consumers skip the
// null holes.
export type MentionableArray = readonly (Mentionable | null)[];

export const MentionableSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
  },
  required: [NAME],
  // While Mentionable may have extra properies on it,
  // we don't need to sync them when using in UI code
  // additionalProperties: true,
} as const satisfies JSONSchema;

export const MentionableArraySchema = {
  type: "array",
  // Per-element degradation, not wholesale void (CT-1863). One space member
  // whose deployed pattern source the current runtime can't load fails
  // MentionableSchema (its NAME never resolves). With a non-nullable element
  // schema the runtime's array traversal voids the ENTIRE read the moment one
  // element fails — so three stranded pieces blanked all 24, emptying the
  // #mention list and any piece view backed by it. Allowing `null` per element
  // makes the existing per-element degradation path fire instead: the bad
  // member becomes a `null` hole and every loadable sibling survives. The
  // `anyOf` order (null first) mirrors the runtime's own nullable-array tests.
  // NOTE: this fixes the mentionable read specifically; hardening the runtime's
  // array traversal to never void wholesale on ANY schema-backed array is a
  // deliberate, broader follow-up (it would change a core read invariant).
  items: {
    anyOf: [
      { type: "null" },
      MentionableSchema,
    ],
  },
} as const satisfies JSONSchema;
