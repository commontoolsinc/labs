import { isRecord } from "@commontools/utils/types";
import {
  type Recipe,
  unsafe_materializeFactory,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  type UnsafeBinding,
} from "./builder/types.ts";
import { isCellLink, isLegacyAlias, isLink } from "./link-utils.ts";
import { type DocImpl, isDoc } from "./doc.ts";
import { type Cell, isCell } from "./cell.ts";
import { type LegacyCellLink } from "./sigil-types.ts";
import { type ReactivityLog } from "./scheduler.ts";
import { followWriteRedirects } from "./link-resolution.ts";
import { diffAndUpdate } from "./data-updating.ts";

/**
 * Sends a value to a binding. If the binding is an array or object, it'll
 * traverse the binding and the value in parallel accordingly. If the binding is
 * an alias, it will follow all aliases and send the value to the last aliased
 * doc. If the binding is a literal, we verify that it matches the value and
 * throw an error otherwise.
 * @param docOrCell - The document or cell context
 * @param binding - The binding to send to
 * @param value - The value to send
 * @param log - Optional reactivity log
 */
export function sendValueToBinding<T>(
  docOrCell: DocImpl<T> | Cell<T>,
  binding: unknown,
  value: unknown,
  log?: ReactivityLog,
): void {
  const doc = isCell(docOrCell) ? docOrCell.getDoc() : docOrCell;
  if (isLegacyAlias(binding)) {
    const ref = followWriteRedirects(binding, doc, log);
    diffAndUpdate(ref, value, log, { doc, binding });
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(binding.length, value.length); i++) {
        sendValueToBinding(docOrCell, binding[i], value[i], log);
      }
    }
  } else if (isRecord(binding) && isRecord(value)) {
    for (const key of Object.keys(binding)) {
      if (key in value) {
        sendValueToBinding(
          docOrCell,
          binding[key],
          value[key],
          log,
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
 * - reduces wrapping count of closure docs by one
 *
 * This is used for arguments to nodes (which can be recipes, e.g. for map) and
 * for the recipe in recipe nodes.
 *
 * An alias will go through these stages:
 * - { $alias: { cell: 1, path: ["a"] } }
 *   = Nested two layers deep, an argment for a nested recipe
 * - { $alias: { path: ["a"] } }
 *   = One layer deep, e.g. a recipe that will be passed to `run`
 * - { $alias: { cell: <doc>, path: ["a"] } }
 *   = Unwrapped, executing the recipe
 *
 * @param binding - The binding to unwrap.
 * @param docOrCell - The doc or cell to bind to.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindtoDoc<T, U>(
  binding: T,
  docOrCell: DocImpl<U> | Cell<U>,
): T {
  const doc = isCell(docOrCell) ? docOrCell.getDoc() : docOrCell;
  function convert(binding: unknown): unknown {
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
      } else if (!alias.cell) {
        alias.cell = doc;
      }
      return { $alias: alias };
    } else if (isDoc(binding)) {
      return binding; // Don't enter docs
    } else if (Array.isArray(binding)) {
      return binding.map((value) => convert(value));
    } else if (isRecord(binding)) {
      const result: Record<string | symbol, unknown> = Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [key, convert(value)]),
      );
      if (binding[unsafe_originalRecipe]) {
        result[unsafe_originalRecipe] = binding[unsafe_originalRecipe];
      }
      return result;
    } else return binding;
  }
  return convert(binding) as T;
}

export function unsafe_noteParentOnRecipes(
  recipe: Recipe,
  binding: unknown,
): void {
  // For now we just do top-level bindings
  if (isRecord(binding)) {
    for (const key in binding) {
      if (isRecord(binding[key]) && binding[key][unsafe_originalRecipe]) {
        binding[key][unsafe_parentRecipe] = recipe;
      }
    }
  }
}

export function unsafe_createParentBindings(
  recipe: Recipe,
  log: ReactivityLog,
): UnsafeBinding | undefined {
  if (!recipe || !recipe[unsafe_originalRecipe]) return undefined;
  else {
    return {
      recipe: recipe[unsafe_originalRecipe]!,
      materialize: recipe[unsafe_materializeFactory]!(log),
      parent: unsafe_createParentBindings(recipe[unsafe_parentRecipe]!, log),
    };
  }
}

// Traverses binding and returns all docs reacheable through aliases.
export function findAllAliasedCells<T>(
  binding: unknown,
  doc: DocImpl<T>,
): LegacyCellLink[] {
  const docs: LegacyCellLink[] = [];
  function find(binding: unknown, origDoc: DocImpl<T>): void {
    if (isLegacyAlias(binding)) {
      // Numbered docs are yet to be unwrapped nested recipes. Ignore them.
      if (typeof binding.$alias.cell === "number") return;
      const doc = (binding.$alias.cell ?? origDoc) as DocImpl<T>;
      const path = binding.$alias.path;
      if (docs.find((c) => c.cell === doc && c.path === path)) return;
      docs.push({ cell: doc as DocImpl<unknown>, path });
      find(doc.getAtPath(path), doc);
    } else if (Array.isArray(binding)) {
      for (const value of binding) find(value, origDoc);
    } else if (isRecord(binding) && !isLink(binding)) {
      for (const value of Object.values(binding)) find(value, origDoc);
    }
  }
  find(binding, doc);
  return docs;
}
