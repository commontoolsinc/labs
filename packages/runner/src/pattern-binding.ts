import { isRecord } from "@commontools/utils/types";
import type { StorableValue } from "@commontools/memory/interface";
import {
  isPattern,
  type Pattern,
  unsafe_originalPattern,
  unsafe_parentPattern,
} from "./builder/types.ts";
import { type AnyCell, type Cell } from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  areNormalizedLinksSame,
  isCellLink,
  isLegacyAlias,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";

/**
 * Sends a value to a binding. If the binding is an array or object, it'll
 * traverse the binding and the value in parallel accordingly. If the binding is
 * an alias, it will follow all aliases and send the value to the last aliased
 * doc. If the binding is a literal, we verify that it matches the value and
 * throw an error otherwise.
 * @param tx - The transaction to use for updates
 * @param docOrCell - The document or cell context
 * @param binding - The binding to send to
 * @param value - The value to send
 */
export function sendValueToBinding<T>(
  tx: IExtendedStorageTransaction,
  cell: AnyCell<T>,
  binding: unknown,
  value: unknown,
): void {
  // Handle both legacy $alias format and new sigil link format
  if (isWriteRedirectLink(binding)) {
    const ref = resolveLink(
      cell.runtime,
      tx,
      parseLink(binding, cell),
      "writeRedirect",
    );
    diffAndUpdate(
      cell.runtime,
      tx,
      ref,
      value as StorableValue,
      { cell: cell.getAsNormalizedFullLink(), binding },
      { meta: ignoreReadForScheduling },
    );
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(binding.length, value.length); i++) {
        sendValueToBinding(tx, cell, binding[i], value[i]);
      }
    }
  } else if (isRecord(binding) && isRecord(value)) {
    for (const key of Object.keys(binding)) {
      if (key in value) {
        sendValueToBinding(tx, cell, binding[key], value[key]);
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
 * @param binding - The binding to unwrap.
 * @param docOrCell - The doc or cell to bind to.
 * @param options - Optional configuration.
 * @param options.bindRecipes - If false, skip binding aliases inside recipe values.
 *   This is used by raw/map nodes to prevent premature alias binding. Default: true.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindtoDoc<T, U>(
  binding: T,
  cell: Cell<U>,
  options?: { bindRecipes?: boolean },
): T {
  const bindRecipes = options?.bindRecipes !== false;

  function convert(binding: unknown, bindToDoc: boolean): unknown {
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
      } else if (!alias.cell && bindToDoc) {
        alias.cell = cell.entityId;
      } else if (
        // CT-1230 WORKAROUND: Rebind local recipe aliases to the current doc.
        //
        // Problem: When a subpattern is used in .map(), its internal/argument/resultRef
        // aliases could be bound to a doc from a previous execution context. When the
        // pattern runs again (e.g., adding a new item), these stale bindings caused
        // stream sentinels to not be found, making handlers incorrectly treated as lifts.
        //
        // Why this helps: If we detect a local alias (internal/argument/resultRef path)
        // that's already bound to a different doc than our current context, we rebind it.
        // This ensures the alias points to the correct doc for this execution.
        //
        // We're uncertain if this is the right architectural fix or just masking a deeper
        // issue with how recipes capture their execution context.
        bindToDoc &&
        alias.cell &&
        Array.isArray(alias.path) &&
        (alias.path[0] === "internal" ||
          alias.path[0] === "argument" ||
          alias.path[0] === "resultRef")
      ) {
        const currentId = (alias.cell as { "/": string })["/"];
        if (currentId !== cell.entityId["/"]) {
          alias.cell = cell.entityId;
        }
      } else if (!bindToDoc && alias.cell) {
        // CT-1230 WORKAROUND: Clear previously-bound alias when not binding to doc.
        //
        // Problem: If a recipe was serialized with an alias already bound to a specific
        // doc, and we're now in a context where we shouldn't bind (e.g., processing
        // a recipe argument to map()), that stale binding could cause issues.
        //
        // Why this helps: Dropping the binding allows the alias to be properly re-bound
        // when the recipe is actually executed in its correct context.
        delete alias.cell;
      }
      return { $alias: alias };
    } else if (Array.isArray(binding)) {
      return binding.map((value) => convert(value, bindToDoc));
    } else if (isRecord(binding)) {
      // CT-1230 WORKAROUND: Don't bind aliases inside recipe values when bindRecipes=false.
      //
      // Problem: When raw/map nodes receive a recipe as an input value, we were binding
      // the aliases inside that recipe to the current doc. But those aliases should
      // remain unbound until the recipe is actually instantiated/executed.
      //
      // Why this helps: By checking isPattern() and respecting bindRecipes option, we
      // avoid premature binding of nested recipe aliases.
      const shouldBind = bindToDoc && (bindRecipes || !isPattern(binding));
      const result: Record<string | symbol, unknown> = Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [
          key,
          convert(value, shouldBind),
        ]),
      );
      if (binding[unsafe_originalPattern]) {
        result[unsafe_originalPattern] = binding[unsafe_originalPattern];
      }
      return result;
    } else return binding;
  }
  return convert(binding, true) as T;
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
    if (isLegacyAlias(binding) && typeof binding.$alias.cell === "number") {
      // Numbered docs are yet to be unwrapped nested patterns. Ignore them.
      return;
    } else if (isWriteRedirectLink(binding)) {
      // If the binding is a write redirect, add the link to the seen list and
      // recurse into the linked cell.
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
