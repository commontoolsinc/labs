import {
  isAlias,
  isStatic,
  markAsStatic,
  unsafe_originalRecipe,
  unsafe_parentRecipe,
  Recipe,
  UnsafeBinding,
  unsafe_materializeFactory,
  isOpaqueRef,
} from "@commontools/common-builder";
import {
  cell,
  isCell,
  isRendererCell,
  CellImpl,
  ReactivityLog,
  CellReference,
  isCellReference,
  isQueryResultForDereferencing,
  getCellReferenceOrThrow,
} from "./cell.js";
import { createRef } from "./cell-map.js";

export function extractDefaultValues(schema: any): any {
  if (typeof schema !== "object" || schema === null) return undefined;

  if (schema.type === "object") {
    const obj: any = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        for (const [propKey, propValue] of Object.entries(value)) {
          const value = extractDefaultValues(propValue);
          if (value !== undefined) obj[propKey] = value;
        }
      }
    }

    return Object.entries(obj).length > 0 ? obj : undefined;
  }

  return schema.default;
}

// Merges objects into a single object, preferring values from later objects.
// Recursively calls itself for nested objects, passing on any objects that
// matching properties.
export function mergeObjects(...objects: any[]): any {
  objects = objects.filter((obj) => obj !== undefined);
  if (objects.length === 0) return undefined;
  if (objects.length === 1) return objects[0];

  const seen = new Set<PropertyKey>();
  const result: any = {};

  for (const obj of objects) {
    // If we have a literal value, return it. Same for arrays, since we wouldn't
    // know how to merge them. Note that earlier objects take precedence, so if
    // an earlier was e.g. an object, we'll return that instead of the literal.
    if (
      typeof obj !== "object" ||
      obj === null ||
      Array.isArray(obj) ||
      isAlias(obj) ||
      isCellReference(obj) ||
      isStatic(obj)
    )
      return obj;

    // Then merge objects, only passing those on that have any values.
    for (const key of Object.keys(obj)) {
      if (seen.has(key)) continue;
      seen.add(key);
      const merged = mergeObjects(...objects.map((obj) => obj[key]));
      if (merged !== undefined) result[key] = merged;
    }
  }

  return result;
}

// Sends a value to a binding. If the binding is an array or object, it'll
// traverse the binding and the value in parallel accordingly. If the binding is
// an alias, it will follow all aliases and send the value to the last aliased
// cell. If the binding is a literal, we verify that it matches the value and
// throw an error otherwise.
export function sendValueToBinding(
  cell: CellImpl<any>,
  binding: any,
  value: any,
  log?: ReactivityLog,
) {
  if (isAlias(binding)) {
    const ref = followAliases(binding, cell, log);
    if (!isCellReference(value) && !isCell(value) && !isAlias(value))
      normalizeToCells(cell, value, ref.cell.getAtPath(ref.path), log, binding);
    setNestedValue(ref.cell, ref.path, value, log);
  } else if (Array.isArray(binding)) {
    if (Array.isArray(value))
      for (let i = 0; i < Math.min(binding.length, value.length); i++)
        sendValueToBinding(cell, binding[i], value[i], log);
  } else if (typeof binding === "object" && binding !== null) {
    for (const key of Object.keys(binding))
      if (key in value) sendValueToBinding(cell, binding[key], value[key], log);
  } else {
    if (binding !== value)
      throw new Error(`Got ${value} instead of ${binding}`);
  }
}

// Sets a value at a path, following aliases and recursing into objects. Returns
// success, meaning no frozen cells were in the way. That is, also returns true
// if there was no change.
export function setNestedValue(
  currentCell: CellImpl<any>,
  path: PropertyKey[],
  value: any,
  log?: ReactivityLog,
): boolean {
  let destValue = currentCell.getAtPath(path);
  if (isAlias(destValue)) {
    const ref = followAliases(destValue, currentCell, log);
    return setNestedValue(ref.cell, ref.path, value, log);
  }

  // Compare destValue and value, if they are the same, recurse, otherwise write
  // value with setAtPath
  if (
    typeof destValue === "object" &&
    destValue !== null &&
    typeof value === "object" &&
    value !== null &&
    Array.isArray(value) === Array.isArray(destValue) &&
    !isCell(value) &&
    !isCellReference(value) &&
    !isRendererCell(value)
  ) {
    let success = true;
    for (const key in value)
      if (key in destValue)
        success &&= setNestedValue(
          currentCell,
          [...path, key],
          value[key],
          log,
        );
      else {
        if (currentCell.isFrozen()) success = false;
        else currentCell.setAtPath([...path, key], value[key], log);
      }
    for (const key in destValue)
      if (!(key in value)) {
        if (currentCell.isFrozen()) success = false;
        else currentCell.setAtPath([...path, key], undefined, log);
      }

    return success;
  } else if (isCellReference(value) && isCellReference(destValue)) {
    if (
      value.cell !== destValue.cell ||
      !arrayEqual(value.path, destValue.path)
    )
      currentCell.setAtPath(path, value, log);
    return true;
  } else if (!Object.is(destValue, value)) {
    // Use Object.is for comparison to handle NaN and -0 correctly
    if (currentCell.isFrozen()) return false;
    currentCell.setAtPath(path, value, log);
    return true;
  }

  return true;
}

/**
 * Unwraps one level of aliases, and
 * - binds top-level aliases to passed cell
 * - reduces wrapping count of closure cells by one
 *
 * This is used for arguments to nodes (which can be recipes, e.g. for map) and
 * for the recipe in recipe nodes.
 *
 * An alias will go through these stages:
 * - { $alias: { cell: 1, path: ["a"] } }
 *   = Nested two layers deep, an argment for a nested recipe
 * - { $alias: { path: ["a"] } }
 *   = One layer deep, e.g. a recipe that will be passed to `run`
 * - { $alias: { cell: <cell>, path: ["a"] } }
 *   = Unwrapped, executing the recipe
 *
 * @param binding - The binding to unwrap.
 * @param cell - The cell to bind to.
 * @returns The unwrapped binding.
 */
export function unwrapOneLevelAndBindtoCell<T>(
  binding: T,
  cell: CellImpl<any>,
): T {
  function convert(binding: any, processStatic = false): any {
    if (isStatic(binding) && !processStatic)
      return markAsStatic(convert(binding, true));
    else if (isAlias(binding)) {
      if (typeof binding.$alias.cell === "number")
        if (binding.$alias.cell === 1)
          // Moved to the next-to-top level. Don't assign a cell, so that on
          // next unwrap, the right cell be assigned.
          return { $alias: { path: binding.$alias.path } };
        else
          return {
            // Otherwise decrease count by one
            $alias: {
              cell: binding.$alias.cell - 1,
              path: binding.$alias.path,
            },
          };
      else
        return {
          // Bind to passed cell, if there isn't already one
          $alias: {
            cell: binding.$alias.cell ?? cell,
            path: binding.$alias.path,
          },
        };
    } else if (isCell(binding))
      return binding; // Don't enter cells
    else if (Array.isArray(binding))
      return binding.map((value) => convert(value));
    else if (typeof binding === "object" && binding !== null) {
      const result: any = Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [key, convert(value)]),
      );
      if (binding[unsafe_originalRecipe])
        result[unsafe_originalRecipe] = binding[unsafe_originalRecipe];
      return result;
    } else return binding;
  }
  return convert(binding) as T;
}

export function unsafe_noteParentOnRecipes(recipe: Recipe, binding: any) {
  if (typeof binding !== "object" || binding === null) return;

  // For now we just do top-level bindings
  for (const key in binding)
    if (binding[key][unsafe_originalRecipe])
      binding[key][unsafe_parentRecipe] = recipe;
}

export function unsafe_createParentBindings(
  recipe: Recipe,
  log: ReactivityLog,
): UnsafeBinding | undefined {
  if (!recipe || !recipe[unsafe_originalRecipe]) return undefined;
  else
    return {
      recipe: recipe[unsafe_originalRecipe]!,
      materialize: recipe[unsafe_materializeFactory]!(log),
      parent: unsafe_createParentBindings(recipe[unsafe_parentRecipe]!, log),
    };
}

// Traverses binding and returns all cells reacheable through aliases.
export function findAllAliasedCells(
  binding: any,
  cell: CellImpl<any>,
): CellReference[] {
  const cells: CellReference[] = [];
  function find(binding: any, origCell: CellImpl<any>) {
    if (isAlias(binding)) {
      // Numbered cells are yet to be unwrapped nested recipes. Ignore them.
      if (typeof binding.$alias.cell === "number") return;
      const cell = binding.$alias.cell ?? origCell;
      const path = binding.$alias.path;
      if (cells.find((c) => c.cell === cell && c.path === path)) return;
      cells.push({ cell, path });
      find(cell.getAtPath(path), cell);
    } else if (Array.isArray(binding)) {
      for (const value of binding) find(value, origCell);
    } else if (
      typeof binding === "object" &&
      binding !== null &&
      !isCellReference(binding) &&
      !isCell(binding) &&
      !isRendererCell(binding)
    ) {
      for (const value of Object.values(binding)) find(value, origCell);
    }
  }
  find(binding, cell);
  return cells;
}

// Follows cell references and returns the last one
export function followCellReferences(
  reference: CellReference,
  log?: ReactivityLog,
): any {
  const seen = new Set<CellReference>();
  let result = reference;

  while (isCellReference(reference)) {
    log?.reads.push(reference);
    result = reference;
    if (seen.has(reference)) throw new Error("Reference cycle detected");
    seen.add(reference);
    reference = reference.cell.getAtPath(reference.path);
  }

  return result;
}

// Follows aliases and returns cell reference describing the last alias.
export function followAliases(
  alias: any,
  cell: CellImpl<any>,
  log?: ReactivityLog,
): CellReference {
  const seen = new Set<any>();
  let result: CellReference;

  if (!isAlias(alias)) throw new Error("Not an alias");
  while (isAlias(alias)) {
    if (alias.$alias.cell) cell = alias.$alias.cell;
    result = { cell, path: alias.$alias.path };

    if (seen.has(alias)) throw new Error("Alias cycle detected");
    seen.add(alias);
    alias = cell.getAtPath(alias.$alias.path);
    if (isAlias(alias)) log?.reads.push({ cell, path: alias.$alias.path });
  }

  return result!;
}

// Remove longer paths already covered by shorter paths
export function compactifyPaths(entries: CellReference[]): CellReference[] {
  // First group by cell via a Map
  const cellToPaths = new Map<CellImpl<any>, PropertyKey[][]>();
  for (const { cell, path } of entries) {
    const paths = cellToPaths.get(cell) || [];
    paths.push(path);
    cellToPaths.set(cell, paths);
  }

  // For each cell, sort the paths by length, then only return those that don't
  // have a prefix earlier in the list
  const result: CellReference[] = [];
  for (const [cell, paths] of cellToPaths.entries()) {
    paths.sort((a, b) => a.length - b.length);
    for (let i = 0; i < paths.length; i++) {
      const earlier = paths.slice(0, i);
      if (
        earlier.some((path) =>
          path.every((key, index) => key === paths[i][index]),
        )
      )
        continue;
      result.push({ cell, path: paths[i] });
    }
  }
  return result;
}

export function pathAffected(changedPath: PropertyKey[], path: PropertyKey[]) {
  return (
    (changedPath.length <= path.length &&
      changedPath.every((key, index) => key === path[index])) ||
    path.every((key, index) => key === changedPath[index])
  );
}

export function transformToRendererCells(
  cell: CellImpl<any>,
  value: any,
  log?: ReactivityLog,
): any {
  if (isQueryResultForDereferencing(value)) {
    const ref = followCellReferences(getCellReferenceOrThrow(value));
    if (cell === ref.cell)
      return transformToRendererCells(cell, cell.getAtPath(ref.path), log);
    else return ref.cell.asRendererCell(ref.path, log);
  } else if (isAlias(value)) {
    const ref = followCellReferences(followAliases(value, cell, log), log);
    return ref.cell.asRendererCell(ref.path, log);
  } else if (isCell(value)) {
    return value.asRendererCell([], log);
  } else if (isCellReference(value)) {
    const ref = followCellReferences(value, log);
    return ref.cell.asRendererCell(ref.path, log);
  } else if (isRendererCell(value)) {
    return value;
  }

  if (typeof value === "object" && value !== null)
    if (Array.isArray(value))
      return value.map((value) => transformToRendererCells(cell, value, log));
    else
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          transformToRendererCells(cell, value, log),
        ]),
      );
  else return value;
}

/**
 * Ensures that all elements of an array are cells. If not, i.e. they are static
 * data, turn them into cell references. Also unwraps proxies.
 *
 * Use e.g. when running a recipe and getting static data as input.
 *
 * @param value - The value to traverse and make sure all arrays are arrays of
 * cells. NOTE: The passed value is mutated.
 * @returns The (potentially unwrapped) input value
 */
export function staticDataToNestedCells(
  parentCell: CellImpl<any>,
  value: any,
  log?: ReactivityLog,
  cause?: any,
): any {
  value = maybeUnwrapProxy(value);
  value = deepCopy(value);
  normalizeToCells(parentCell, value, undefined, log, cause);
  return value;
}

/**
 * Ensures that all elements of an array are cells. If not, i.e. they are static
 * data, turn them into cells. "Is a cell" means it's either a cell, a cell
 * reference or an alias.
 *
 * Pass the previous value to reuse cells from previous transitions. It does so
 * if the values match, but only on arrays (as for objects we don't (yet?) do
 * this behind the scenes translation).
 *
 * @param value - The value to traverse and make sure all arrays are arrays of
 * cells.
 * @returns Whether the value was changed.
 */
export function normalizeToCells(
  parentCell: CellImpl<any>,
  value: any,
  previous?: any,
  log?: ReactivityLog,
  cause: any = createRef(),
): boolean {
  value = maybeUnwrapProxy(value);
  previous = maybeUnwrapProxy(previous);

  let changed = false;
  if (isStatic(value)) {
    // no-op, don't normalize deep static values and assume they don't change
  } else if (isCell(value) || isRendererCell(value)) {
    changed = value !== previous;
  } else if (isCellReference(value)) {
    changed = isCellReference(previous)
      ? value.cell !== previous.cell || !arrayEqual(value.path, previous.path)
      : true;
  } else if (isAlias(value)) {
    changed = isAlias(previous)
      ? value.$alias.cell !== previous.$alias.cell ||
        !arrayEqual(value.$alias.path, previous.$alias.path)
      : true;
  } else if (Array.isArray(value)) {
    if (!Array.isArray(previous)) {
      previous = undefined;
      changed = true;
    } else if (value.length !== previous.length) {
      changed = true;
    }
    let itemId = null;
    let preceedingItemId = null;
    for (let i = 0; i < value.length; i++) {
      const item = maybeUnwrapProxy(value[i]);
      if (item !== value[i]) value[i] = item; // Capture unwrapped value
      const previousItem = previous ? maybeUnwrapProxy(previous[i]) : undefined;
      if (
        !(
          isCell(item) ||
          isCellReference(item) ||
          isAlias(item) ||
          isRendererCell(item)
        )
      ) {
        // TODO: Should this depend on the value if there is no id provided?
        // This is probably generating extra churn on ids.
        itemId =
          typeof item === "object" && item !== null && "id" in item
            ? createRef({ id: item.id }, { parent: cause })
            : createRef(value[i], {
                parent: cause,
                index: i,
                preceeding: preceedingItemId,
              });
        const different = normalizeToCells(
          parentCell,
          value[i],
          isCellReference(previousItem)
            ? previousItem.cell.getAtPath(previousItem.path)
            : previousItem,
          log,
          isCellReference(previousItem)
            ? previousItem.cell.entityId ?? itemId
            : itemId,
        );
        if (
          !different &&
          previous &&
          previous[i] &&
          isCellReference(previous[i])
        ) {
          value[i] = previous[i];
          preceedingItemId = previousItem.cell.entityId;
          // NOTE: We don't treat making it a cell reference as a change, since
          // we'll still have the same value. This is reusing the cell reference
          // transition from a previous run, but only if the value didn't
          // change as well.
        } else {
          value[i] = { cell: cell(value[i]), path: [] } satisfies CellReference;
          value[i].cell.entityId = itemId;
          value[i].cell.sourceCell = parentCell;

          preceedingItemId = itemId;
          log?.writes.push(value[i]);
          changed = true;
        }
      }
    }
  } else if (typeof value === "object" && value !== null) {
    if (typeof previous !== "object" || previous === null) {
      previous = undefined;
      changed = true;
    }
    for (const key in value) {
      const item = maybeUnwrapProxy(value[key]);
      if (item !== value[key]) value[key] = item; // Capture unwrapped value
      const previousItem = previous
        ? maybeUnwrapProxy(previous[key])
        : undefined;
      let change = normalizeToCells(parentCell, item, previousItem, log, {
        parent: cause,
        key,
      });
      changed ||= change;
    }
    if (!changed) {
      for (const key in previous) {
        if (!(key in value)) {
          changed = true;
          break;
        }
      }
    }
  } else if (isCellReference(previous)) {
    // value is a literal value here and the last clause
    changed = value !== previous.cell.getAtPath(previous.path);
  } else {
    changed = value !== previous;
  }
  return changed;
}

function maybeUnwrapProxy(value: any): any {
  return isQueryResultForDereferencing(value)
    ? getCellReferenceOrThrow(value)
    : value;
}

export function arrayEqual(a: PropertyKey[], b: PropertyKey[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isEqualCellReferences(
  a: CellReference,
  b: CellReference,
): boolean {
  return (
    isCellReference(a) &&
    isCellReference(b) &&
    a.cell === b.cell &&
    arrayEqual(a.path, b.path)
  );
}

export function containsOpaqueRef(value: any): boolean {
  if (isOpaqueRef(value)) return true;
  if (typeof value === "object" && value !== null)
    return Object.values(value).some(containsOpaqueRef);
  return false;
}

export function deepCopy(value: any): any {
  if (isCell(value) || isRendererCell(value)) return value;
  if (typeof value === "object" && value !== null)
    return Array.isArray(value)
      ? value.map(deepCopy)
      : Object.fromEntries(
          Object.entries(value).map(([key, value]) => [key, deepCopy(value)]),
        );
  else return value;
}
