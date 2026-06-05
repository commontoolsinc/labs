import { isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  type JSONSchema,
  type JSONValue,
  type Pattern,
  unsafe_originalPattern,
  unsafe_parentPattern,
  unsafe_verifiedLoadId,
} from "./builder/types.ts";
import { type AnyCell } from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCellLink,
  getMetaLink,
  isCellLink,
  isLegacyAlias,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type {
  Cell,
  CellScope,
  DerivedInternalCellDescriptor,
} from "./builder/types.ts";
import { isCellScope, scopeRank } from "./scope.ts";

type SendValueToBindingOptions = {
  narrowestReadScope?: CellScope;
  preserveLinkOutput?: boolean;
  derivedInternalCells?: readonly DerivedInternalCellDescriptor[];
};

type UnwrapOneLevelOptions = {
  targetSchema?: JSONSchema;
  derivedInternalCells?: readonly DerivedInternalCellDescriptor[];
};

const scopedLinkForPath = (
  cfc: ContextualFlowControl,
  link: NormalizedFullLink,
  path: readonly string[],
  schemaOverride?: JSONSchema,
): NormalizedFullLink => {
  let scope = link.scope;
  let schema = link.schema;
  let childSchema: JSONSchema | undefined;

  for (const key of path) {
    childSchema = cfc.getSchemaAtPath(schema, [key]);
    if (isRecord(childSchema) && isCellScope(childSchema.scope)) {
      scope = childSchema.scope;
    }
    schema = childSchema;
  }

  const finalSchema = schemaOverride ?? childSchema;
  if (isRecord(finalSchema)) {
    if (isCellScope(finalSchema.scope)) {
      scope = finalSchema.scope;
    }
    const asCellEntry = ContextualFlowControl.getAsCellValues(finalSchema)[0];
    const asCellScope = ContextualFlowControl.getAsCellScope(asCellEntry);
    if (isCellScope(asCellScope)) {
      scope = asCellScope;
    }
  }

  return {
    ...link,
    path: [...path],
    scope,
    ...(finalSchema !== undefined && { schema: finalSchema }),
  };
};

const descriptorForPartialCauseAlias = (
  partialCause: JSONValue,
  descriptors: readonly DerivedInternalCellDescriptor[] | undefined,
): DerivedInternalCellDescriptor => {
  const descriptor = descriptors?.find((descriptor) =>
    deepEqual(descriptor.partialCause, partialCause)
  );
  if (!descriptor) {
    throw new Error(
      `Unknown derived internal cell: ${partialCause}`,
    );
  }
  return descriptor;
};

/**
 * Sends a value to a binding. If the binding is an array or object, it'll
 * traverse the binding and the value in parallel accordingly. If the binding is
 * an alias, it will follow all aliases and send the value to the last aliased
 * doc. If the binding is a literal, we verify that it matches the value and
 * throw an error otherwise.
 *
 * @param tx - The transaction to use for updates
 * @param cell - The document or cell context
 * @param argumentCellLink - The link to the argument cell
 * @param binding - The binding to send to
 * @param value - The value to send
 */
export function sendValueToBinding<T>(
  tx: IExtendedStorageTransaction,
  cell: AnyCell<T>,
  argumentCellLink: NormalizedFullLink | undefined,
  binding: unknown,
  value: unknown,
  options: SendValueToBindingOptions = {},
): void {
  if (argumentCellLink === undefined) {
    argumentCellLink = getMetaLink(cell as Cell<unknown>, "argument")!;
  }
  // Handle both legacy $alias format and new sigil link format
  if (isWriteRedirectLink(binding)) {
    if (isLegacyAlias(binding)) {
      const alias = binding.$alias;
      if ((alias.defer ?? 0) > 0) {
        throw new Error(
          `Cannot write to deferred alias: ${JSON.stringify(binding)}`,
        );
      }
      if (alias.partialCause !== undefined) {
        const partialCause = alias.partialCause;
        const descriptor = descriptorForPartialCauseAlias(
          partialCause,
          options.derivedInternalCells,
        );
        binding = createSigilLinkFromParsedLink(
          scopedLinkForPath(
            cell.runtime.cfc,
            getDerivedInternalCellLink(cell as any, descriptor),
            alias.path,
            alias.schema,
          ),
          { includeSchema: true, overwrite: "redirect" },
        );
      } else if (typeof alias.cell !== "string") {
        throw new Error(
          "Invalid pseudo-alias cell: " + JSON.stringify(binding),
        );
      } else {
        // Certain strings have special meaning as the cell id
        const link = alias.cell === "argument"
          ? argumentCellLink
          : alias.cell === "result"
          ? cell.getAsNormalizedFullLink()
          : undefined;
        if (link === undefined) {
          throw new Error("Invalid pseudo-alias path: " + alias.path);
        }
        const path = alias.path;
        binding = createSigilLinkFromParsedLink(
          scopedLinkForPath(cell.runtime.cfc, link, path, alias.schema),
          { includeSchema: true, overwrite: "redirect" },
        );
      }
    }

    const bindingLink = parseLink(binding, cell)!;
    const ref = resolveLink(
      cell.runtime,
      tx,
      bindingLink,
      "writeRedirect",
      { preserveOverwrite: true },
    );
    const outputScope = options.narrowestReadScope;
    if (
      outputScope !== undefined &&
      scopeRank(outputScope) > scopeRank(ref.scope)
    ) {
      const scopedRef = { ...ref, scope: outputScope };
      const valueLink = isCellLink(value) ? parseLink(value, ref) : undefined;
      if (
        valueLink === undefined ||
        !areNormalizedLinksSame(valueLink, scopedRef)
      ) {
        diffAndUpdate(
          cell.runtime,
          tx,
          scopedRef,
          value as FabricValue,
          { cell: cell.getAsNormalizedFullLink(), binding },
          { meta: ignoreReadForScheduling },
        );
      }
      tx.writeValueOrThrow(
        bindingLink,
        createSigilLinkFromParsedLink(scopedRef, {
          base: bindingLink,
        }) as FabricValue,
      );
      return;
    }
    if (options.preserveLinkOutput) {
      const valueLink = isCellLink(value)
        ? parseLink(value, bindingLink)
        : undefined;
      if (
        valueLink !== undefined &&
        !areNormalizedLinksSame(valueLink, bindingLink)
      ) {
        tx.writeValueOrThrow(
          bindingLink,
          createSigilLinkFromParsedLink(valueLink) as FabricValue,
        );
        return;
      }
    }
    diffAndUpdate(
      cell.runtime,
      tx,
      ref,
      value as FabricValue,
      { cell: cell.getAsNormalizedFullLink(), binding },
      { meta: ignoreReadForScheduling },
    );
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(binding.length, value.length); i++) {
        sendValueToBinding(
          tx,
          cell,
          argumentCellLink,
          binding[i],
          value[i],
          options,
        );
      }
    }
  } else if (isRecord(binding) && isRecord(value)) {
    for (const key of Object.keys(binding)) {
      if (key in value) {
        sendValueToBinding(
          tx,
          cell,
          argumentCellLink,
          binding[key],
          value[key],
          options,
        );
      }
    }
  } else if (!isRecord(binding) || Object.keys(binding).length !== 0) {
    if (binding !== value) {
      throw new Error(`Got ${value} instead of ${binding}`);
    }
  }
}

/**
 * Unwraps one level of aliases, and
 * - binds top-level aliases to passed doc
 *
 * This is used for arguments to nodes (which can be patterns, e.g. for map) and
 * for the pattern in pattern nodes.
 *
 * An alias will go through these stages:
 * - { $alias: { cell: "argument", path: ["a"], defer: 1 } }
 *   = Deferred one level, e.g. a nested pattern's argument alias
 * - { $alias: { partialCause: "foo", path: [], defer: 1 } }
 *   = Deferred one level, e.g. a nested pattern's derived internal alias
 * - { $alias: { cell: <doc>, path: ["a"] } }
 *   = Unwrapped, executing the pattern
 *
 * @param cfc - The ContextualFlowControl object, which we need to get the schema at sub-paths
 * @param binding - The binding to unwrap.
 * @param argumentCellLink - The link to the argument cell
 * @param resultCell - The result cell used to resolve result aliases
 * @param options - Optional configuration.
 * @param options.targetSchema - Schema for the binding being produced. Source
 *   links still resolve through the argument/result links above, but emitted
 *   links are annotated with the corresponding target schema.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindtoDoc<T, U>(
  cfc: ContextualFlowControl,
  binding: T,
  argumentCellLink: NormalizedFullLink,
  resultCell: AnyCell<any>,
  options?: UnwrapOneLevelOptions,
): T {
  const resultCellLink = resultCell.getAsNormalizedFullLink();

  function convert(
    binding: unknown,
    targetSchema: JSONSchema | undefined,
  ): unknown {
    if (isLegacyAlias(binding)) {
      const { defer: optDefer, ...aliasRest } = { ...binding.$alias };
      const defer = optDefer ?? 0;
      if (defer > 0) {
        return {
          $alias: { ...aliasRest, ...((defer > 1) && { defer: defer - 1 }) },
        };
      }
      const alias = binding.$alias;
      if (alias.partialCause !== undefined) {
        const partialCause = alias.partialCause;
        const descriptor = descriptorForPartialCauseAlias(
          partialCause,
          options?.derivedInternalCells,
        );
        const link = getDerivedInternalCellLink(resultCell as any, descriptor);
        const path = alias.path;
        const sourceSchema = alias.schema !== undefined
          ? alias.schema
          : link.schema !== undefined
          ? cfc.schemaAtPath(link.schema, path)
          : undefined;
        return createSigilLinkFromParsedLink(
          scopedLinkForPath(cfc, link, path, targetSchema ?? sourceSchema),
          { includeSchema: true, overwrite: "redirect" },
        );
      } else if (typeof alias.cell === "string") {
        // Resolve the special values for "argument" and "result".
        const link = alias.cell === "argument"
          ? argumentCellLink
          : alias.cell === "result"
          ? resultCellLink
          : undefined;
        if (link === undefined) {
          throw new Error("Invalid pseudo-alias cell: " + alias.cell);
        }
        const path = alias.path;
        // we might have a schema in the alias, but if not, we may have one
        // in the link (from the pattern)
        const sourceSchema = alias.schema !== undefined
          ? alias.schema
          : link.schema !== undefined
          ? cfc.schemaAtPath(link.schema, path)
          : undefined;
        return createSigilLinkFromParsedLink(
          scopedLinkForPath(cfc, link, path, targetSchema ?? sourceSchema),
          { includeSchema: true, overwrite: "redirect" },
        );
      }
      // TODO(@ubik2) - we may never get here -- see if this can be removed
      return { $alias: alias };
    } else if (Array.isArray(binding)) {
      return binding.map((value, index) =>
        convert(
          value,
          cfc.getSchemaAtPath(targetSchema, [String(index)]),
        )
      );
    } else if (isRecord(binding)) {
      const result: Record<string | symbol, unknown> = Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [
          key,
          convert(value, cfc.getSchemaAtPath(targetSchema, [key])),
        ]),
      );
      if (binding[unsafe_originalPattern]) {
        result[unsafe_originalPattern] = binding[unsafe_originalPattern];
      }
      if (binding[unsafe_verifiedLoadId]) {
        result[unsafe_verifiedLoadId] = binding[unsafe_verifiedLoadId];
      }
      return result;
    } else return binding;
  }
  return convert(binding, options?.targetSchema) as T;
}

export function unsafe_noteParentOnPatterns(
  pattern: Pattern,
  binding: unknown,
): void {
  // For now we just do top-level bindings
  if (isRecord(binding)) {
    for (const key in binding) {
      if (isRecord(binding[key]) && binding[key][unsafe_originalPattern]) {
        binding[key][unsafe_parentPattern] = pattern;
      }
    }
  }
}

/**
 * Traverses binding and returns all cells reachable through write redirects.
 *
 * @param binding - The binding to traverse.
 * @param baseCell - The base cell to use for resolving links.
 * @returns All links reachable through write redirects.
 */
export function findAllWriteRedirectCells<T>(
  binding: unknown,
  baseCell: AnyCell<T>,
): NormalizedFullLink[] {
  const seen: NormalizedFullLink[] = [];
  function find(binding: unknown, baseCell: AnyCell<T>): void {
    if (isLegacyAlias(binding) && (binding.$alias.defer ?? 0) > 0) {
      return;
    } else if (isWriteRedirectLink(binding)) {
      // If the binding is a write redirect, add the link to the seen list and
      // recurse into the linked cell.
      // TODO(@ubik2): Need to determine whether this baseCell can be the resultCell. If the binding's link is missing an id, this will
      // turn into a link into the processCell, which I want to eliminate.
      const link = parseLink(binding, baseCell);
      if (seen.find((s) => areNormalizedLinksSame(s, link))) return;
      seen.push(link);
      const linkCell = baseCell.runtime.getCellFromLink(
        link,
        undefined,
        baseCell.tx,
      );
      if (!linkCell) throw new Error("Link cell not found");
      find(linkCell.getRaw({ meta: ignoreReadForScheduling }), baseCell);
    } else if (isCellLink(binding)) {
      // Links that are not write redirects: Ignore them.
      return;
    } else if (Array.isArray(binding)) {
      // If the binding is an array, recurse into each element.
      for (const value of binding) find(value, baseCell);
    } else if (isRecord(binding) && !isCellLink(binding)) {
      // If the binding is an object, recurse into each value.
      for (const value of Object.values(binding)) find(value, baseCell);
    }
  }
  find(binding, baseCell);
  return seen;
}
