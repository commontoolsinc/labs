import type { CellScope, LinkScope, SchemaScope } from "./builder/types.ts";

export const DEFAULT_CELL_SCOPE: CellScope = "space";

export const CELL_SCOPES = ["space", "user", "session"] as const;

const scopeRankByValue: Record<CellScope, number> = {
  space: 0,
  user: 1,
  session: 2,
};

export function isCellScope(value: unknown): value is CellScope {
  return value === "space" || value === "user" || value === "session";
}

export function isSchemaScope(value: unknown): value is SchemaScope {
  return isCellScope(value) || value === "any";
}

export function isLinkScope(value: unknown): value is LinkScope {
  return value === "inherit" || isCellScope(value);
}

export function normalizeCellScope(scope: CellScope | undefined): CellScope {
  return scope ?? DEFAULT_CELL_SCOPE;
}

export function resolveLinkScope(
  scope: LinkScope | undefined,
  containingScope: CellScope | undefined,
): CellScope {
  if (scope === undefined || scope === "inherit") {
    return normalizeCellScope(containingScope);
  }
  return scope;
}

export function scopeRank(scope: CellScope): number {
  return scopeRankByValue[scope];
}

export function narrowestScope(
  scopes: Iterable<CellScope | undefined>,
): CellScope {
  let narrowest: CellScope = DEFAULT_CELL_SCOPE;
  for (const scope of scopes) {
    if (scope !== undefined && scopeRank(scope) > scopeRank(narrowest)) {
      narrowest = scope;
    }
  }
  return narrowest;
}

export function canFollowScopedLink(
  schemaScope: SchemaScope | undefined,
  linkScope: CellScope,
): boolean {
  if (schemaScope === undefined || schemaScope === "any") {
    return true;
  }
  return scopeRank(linkScope) <= scopeRank(schemaScope);
}
