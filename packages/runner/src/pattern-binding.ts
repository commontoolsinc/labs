import { isRecord } from "@commonfabric/utils/types";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import {
  isPattern,
  type JSONSchema,
  unsafe_originalPattern,
} from "./builder/types.ts";
import {
  getVerifiedLoadId,
  setVerifiedLoadId,
} from "./builder/pattern-metadata.ts";
import { type AnyCell } from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  isCellLink,
  isLegacyAlias,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import { ContextualFlowControl } from "./cfc.ts";
import type { CellScope } from "./builder/types.ts";
import { isCellScope, scopeRank } from "./scope.ts";

type SendValueToBindingOptions = {
  narrowestReadScope?: CellScope;
};

type UnwrapOneLevelOptions = {
  bindPatterns?: boolean;
  targetSchema?: JSONSchema;
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

/**
 * Sends a value to a binding. If the binding is an array or object, it'll
 * traverse the binding and the value in parallel accordingly. If the binding is
 * an alias, it will follow all aliases and send the value to the last aliased
 * doc. If the binding is a literal, we verify that it matches the value and
 * throw an error otherwise.
 *
 * @param tx - The transaction to use for updates
 * @param resultCell - The document or cell context
 * @param argumentCellLink - The link to the argument cell
 * @param internalCellLink - The link to the internal cell
 * @param binding - The binding to send to
 * @param value - The value to send
 */
export function sendValueToBinding<T>(
  tx: IExtendedStorageTransaction,
  cell: AnyCell<T>,
  argumentCellLink: NormalizedFullLink,
  internalCellLink: NormalizedFullLink,
  binding: unknown,
  value: unknown,
  options: SendValueToBindingOptions = {},
): void {
  // Handle both legacy $alias format and new sigil link format
  if (isWriteRedirectLink(binding)) {
    if (isLegacyAlias(binding)) {
      const alias = binding.$alias;
      if (typeof alias.cell !== "string") {
        throw new Error(
          "Invalid pseudo-alias cell: " + JSON.stringify(binding),
        );
      }
      // Certain strings have special meaning as the cell id
      const link = alias.cell === "argument"
        ? argumentCellLink
        : alias.cell === "internal"
        ? internalCellLink
        : alias.cell === "result"
        ? parseLink(cell.getAsWriteRedirectLink(), cell)
        : undefined;
      if (link === undefined) {
        throw new Error("Invalid pseudo-alias path: " + alias.path);
      }
      const path = alias.path.map((p) => p.toString());
      binding = createSigilLinkFromParsedLink(
        scopedLinkForPath(cell.runtime.cfc, link, path, alias.schema),
        { includeSchema: true, overwrite: "redirect" },
      );
    }

    const ref = resolveLink(
      cell.runtime,
      tx,
      parseLink(binding, cell)!,
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
        ref,
        createSigilLinkFromParsedLink(scopedRef, { base: ref }) as FabricValue,
      );
      return;
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
          internalCellLink,
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
          internalCellLink,
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
 * - { $alias: { cell: 1, path: ["a"] } }
 *   = Nested two layers deep, an argment for a nested pattern
 * - { $alias: { path: ["a"] } }
 *   = One layer deep, e.g. a pattern that will be passed to `run`
 * - { $alias: { cell: <doc>, path: ["a"] } }
 *   = Unwrapped, executing the pattern
 *
 * @param cfc - The ContextualFlowControl object, which we need to get the schema at sub-paths
 * @param binding - The binding to unwrap.
 * @param argumentCellLink - The link to the argument cell
 * @param internalCellLink - The link to the internal cell
 * @param resultCellLink - The link to the result cell
 * @param options - Optional configuration.
 * @param options.bindPatterns - If false, skip binding aliases inside pattern values.
 *   This is used by raw/map nodes to prevent premature alias binding. Default: true.
 * @param options.targetSchema - Schema for the binding being produced. Source
 *   links still resolve through the argument/internal/result links above, but
 *   emitted links are annotated with the corresponding target schema.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindtoDoc<T, U>(
  cfc: ContextualFlowControl,
  binding: T,
  argumentCellLink: NormalizedFullLink,
  internalCellLink: NormalizedFullLink,
  resultCellLink: NormalizedFullLink,
  options?: UnwrapOneLevelOptions,
): T {
  const bindPatterns = options?.bindPatterns !== false;

  function convert(
    binding: unknown,
    bindToDoc: boolean,
    targetSchema: JSONSchema | undefined,
  ): unknown {
    if (isLegacyAlias(binding)) {
      const alias = { ...binding.$alias };
      if (typeof alias.cell === "number") {
        if (alias.cell === 1) {
          // Moved to the next-to-top level. Don't assign a doc, so that on
          // next unwrap, the right doc be assigned.
          delete alias.cell;
        } else {
          alias.cell = alias.cell - 1;
        }
      } else if (typeof alias.cell === "string" && bindToDoc) {
        // Resolve the special values for "argument" and "internal"
        // we can't use "result" here.
        const link = alias.cell === "argument"
          ? argumentCellLink
          : alias.cell === "internal"
          ? internalCellLink
          : alias.cell === "result"
          ? resultCellLink
          : undefined;
        if (link === undefined) {
          throw new Error("Invalid pseudo-alias cell: " + alias.cell);
        }
        const path = alias.path.map((p) => p.toString());
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
      } else if (Array.isArray(alias.cell)) {
        const { cell, ...rest } = alias;
        if (cell.length < 2) {
          // probably an error, but remove cell
          return { $alias: rest };
        } else if (cell.length === 2) {
          // If after removing the first element, we only will have one,
          // convert it to a string instead of array
          return { $alias: { ...rest, cell: cell[1] } };
        } else {
          // If there's more elements remove the first
          return { $alias: { ...rest, cell: cell.slice(1) } };
        }
      } else if (!bindToDoc && alias.cell) {
        // CT-1230 WORKAROUND: Clear previously-bound alias when not binding to doc.
        //
        // Problem: If a pattern was serialized with an alias already bound to a specific
        // doc, and we're now in a context where we shouldn't bind (e.g., processing
        // a pattern argument to map()), that stale binding could cause issues.
        //
        // Why this helps: Dropping the binding allows the alias to be properly re-bound
        // when the pattern is actually executed in its correct context.
        delete alias.cell;
      }
      // TODO(@ubik2) - we may never get here -- see if this can be removed
      return { $alias: alias };
    } else if (Array.isArray(binding)) {
      return binding.map((value, index) =>
        convert(
          value,
          bindToDoc,
          cfc.getSchemaAtPath(targetSchema, [String(index)]),
        )
      );
    } else if (isRecord(binding)) {
      // CT-1230 WORKAROUND: Don't bind aliases inside pattern values when bindPatterns=false.
      //
      // Problem: When raw/map nodes receive a pattern as an input value, we were binding
      // the aliases inside that pattern to the current doc. But those aliases should
      // remain unbound until the pattern is actually instantiated/executed.
      //
      // Why this helps: By checking isPattern() and respecting bindPatterns option, we
      // avoid premature binding of nested pattern aliases.
      const shouldBind = bindToDoc && (bindPatterns || !isPattern(binding));
      const result: Record<string | symbol, unknown> = Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [
          key,
          convert(value, shouldBind, cfc.getSchemaAtPath(targetSchema, [key])),
        ]),
      );
      if (binding[unsafe_originalPattern]) {
        result[unsafe_originalPattern] = binding[unsafe_originalPattern];
      }
      const verifiedLoadId = getVerifiedLoadId(binding);
      if (verifiedLoadId) {
        setVerifiedLoadId(result, verifiedLoadId);
      }
      return result;
    } else return binding;
  }
  return convert(binding, true, options?.targetSchema) as T;
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
  // `baseCell` is only used for link resolution (runtime/tx/parseLink), which
  // does not depend on the cell's value type, so accept any cell. This lets the
  // redirect-chain recursion re-base onto the resolved `linkCell` (a
  // `Cell<unknown>`) rather than the original typed base.
  function find(binding: unknown, baseCell: AnyCell<unknown>): void {
    if (isLegacyAlias(binding) && typeof binding.$alias.cell === "number") {
      // Numbered docs are yet to be unwrapped nested patterns. Ignore them.
      return;
    } else if (isWriteRedirectLink(binding)) {
      // Follow a *chain* of write redirects: record this redirect, then if its
      // target value is ITSELF a write redirect, follow that too (one string of
      // redirects). We stop as soon as the target is a non-redirect value — we
      // do NOT recurse into it looking for further nested redirects.
      //
      // (Previously this recursed via `find(linkCell.getRaw(...))`, which walked
      // the whole target value structurally — the transitive closure across
      // documents — and was the dominant reload instantiation cost: resolving a
      // cell + walking its entire value per link. Following only direct redirect
      // chains keeps the cases that matter without the deep dive.)
      const link = parseLink(binding, baseCell);
      if (seen.find((s) => areNormalizedLinksSame(s, link))) return;
      seen.push(link);
      const linkCell = baseCell.runtime.getCellFromLink(
        link,
        undefined,
        baseCell.tx,
      );
      if (!linkCell) throw new Error("Link cell not found");
      const target = linkCell.getRaw({ meta: ignoreReadForScheduling });
      // Resolve the next redirect relative to `linkCell` (the cell the chained
      // redirect lives in), not the original `baseCell`: a relative redirect in
      // a cross-document target must resolve against its own document.
      if (isWriteRedirectLink(target)) find(target, linkCell);
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
