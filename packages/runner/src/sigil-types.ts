import type { JSONSchema } from "@commontools/api";
import type { MemorySpace } from "@commontools/memory/interface";
import type { ShadowRef } from "./builder/types.ts";
import type { DocImpl } from "./doc.ts";
import type { URI } from "@commontools/memory/interface";

export type { URI } from "@commontools/memory/interface";

/**
 * Generic sigil value type for future extensions
 */
export type SigilValue<T> = { "/": T };

/**
 * Link sigil value v1
 */

export const LINK_V1_TAG = "link@1" as const;

export type LinkV1 = {
  [LINK_V1_TAG]: {
    id?: URI;
    path?: readonly string[];
    space?: MemorySpace;
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
    overwrite?: "redirect" | "this"; // default is "this"
  };
};

export type WriteRedirectV1 = LinkV1 & {
  [LINK_V1_TAG]: { overwrite: "redirect" };
};
/**
 * Sigil link type
 */

export type SigilLink = SigilValue<LinkV1>;
/**
 * Sigil alias type - uses LinkV1 with overwrite field
 */

export type SigilWriteRedirectLink = SigilValue<WriteRedirectV1>;

/****************
 * Legacy types *
 ****************/

/**
 * Legacy doc cell link.
 *
 * @deprecated Switch to sigil links instead.
 *
 * A legacy doc cell link is a doc and a path within that doc.
 */
export type LegacyDocCellLink = {
  space?: MemorySpace;
  cell: DocImpl<any>;
  path: PropertyKey[];
  schema?: JSONSchema;
  rootSchema?: JSONSchema;
};

/**
 * Legacy alias.
 *
 * @deprecated Switch to sigil write redirect links instead.
 *
 * A legacy alias is a cell and a path within that cell.
 */
export type LegacyAlias = {
  $alias: {
    cell?: DocImpl<any> | ShadowRef | number;
    path: readonly PropertyKey[];
    schema?: JSONSchema;
    rootSchema?: JSONSchema;
  };
};

/**
 * JSON cell link format used in storage.
 *
 * @deprecated Switch to sigil links instead.
 */
export type LegacyJSONCellLink = {
  cell: { "/": string };
  path: (string | number)[];
};
