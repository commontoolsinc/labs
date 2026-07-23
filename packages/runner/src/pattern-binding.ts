import { isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model/fabric-value";
import { isPattern, type JSONSchema, type JSONValue } from "./builder/types.ts";
import { noteDerivedCopy } from "./builder/pattern-metadata.ts";
import { type AnyCell } from "./cell.ts";
import { resolveLink } from "./link-resolution.ts";
import { diffAndUpdate } from "./data-updating.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCellLink,
  getMetaLink,
  isAliasBinding,
  isCellLink,
  isWriteRedirectLink,
  KeepAsCell,
  type NormalizedFullLink,
  parseLink,
  sanitizeSchemaForLinks,
} from "./link-utils.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import {
  internalVerifierRead,
  machineryRead,
} from "./storage/reactivity-log.ts";
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
  /**
   * The containing pattern's authored argument schema, used as the source of
   * declared cell scopes when serializing binding aliases (see
   * `foldDeclaredScopeIntoLinkSchema`). The argument cell LINK only carries a
   * sanitized schema (`sanitizeSchemaForLinks` strips `asCell` entries,
   * taking their scope annotation with them), so a `PerUser<Cell<>>`
   * declaration is invisible on the link by the time aliases are bound. The
   * authored pattern schema keeps `asCell` (`keepAsCell: KeepAsCell.All` in
   * builder/pattern.ts) and is the ground truth for what each slot declared.
   * (Internal cells don't need this: each derived internal cell carries its
   * declared scope on its descriptor, realized directly on its link.)
   */
  sourceSchemas?: {
    argument?: JSONSchema;
  };
};

/**
 * Folds the source slot's declared cell scope into the serialized alias link's
 * schema, making the stored link self-describing.
 *
 * A binding alias serialized into a sub-piece's argument doc carries the
 * sub-pattern's (typically scope-silent) input schema, not the parent slot's
 * schema — so the parent's `PerUser`/`PerSession` declaration (emitted as
 * `asCell: [{kind, scope}]`) is dropped, and any consumer of the stored link
 * must rely on the stored base-slot redirect existing to land reads and writes
 * in the scoped instance. Folding the declared scope into the link's schema
 * (as a top-level `scope`, which survives link-schema sanitization where
 * `asCell` entries do not) keeps the serialized graph self-describing: writes
 * through the link take the scope-narrowing branch and reads get the follow
 * cap, per "scope lives in the schema, realized at read/write".
 *
 * The scope is deliberately NOT stamped onto the link's own `scope`: the link
 * addresses the base-scope slot, where passed-in cell references legitimately
 * live (see "lift can read session-scoped cell passed from pattern input" in
 * pattern-scope.test.ts, and the matching guidance on
 * ContextualFlowControl.getSchemaScopeCap).
 *
 * Folding applies exactly when the write-path narrowing branch would fire for
 * the slot (declared scope narrower than the slot's link scope) and the
 * emitted schema does not declare a scope of its own (a local declaration
 * wins). Slots whose emitted link carries no schema at all are left alone so
 * they keep inheriting the reader's schema during link resolution.
 */
const foldDeclaredScopeIntoLinkSchema = (
  cfc: ContextualFlowControl,
  link: NormalizedFullLink,
  authoredRootSchema: JSONSchema | undefined,
  path: readonly string[],
): NormalizedFullLink => {
  if (authoredRootSchema === undefined || !isRecord(link.schema)) return link;
  if (ContextualFlowControl.getSchemaScopeCap(link.schema) !== undefined) {
    return link;
  }
  const authoredSlotSchema = path.length > 0
    ? cfc.getSchemaAtPath(authoredRootSchema, [...path])
    : authoredRootSchema;
  const declaredCap = ContextualFlowControl.getSchemaScopeCap(
    authoredSlotSchema,
  );
  if (
    !isCellScope(declaredCap) ||
    scopeRank(declaredCap) <= scopeRank(link.scope)
  ) {
    return link;
  }
  return { ...link, schema: { ...link.schema, scope: declaredCap } };
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
  const linkSchema = finalSchema === undefined
    ? undefined
    : sanitizeAliasSchemaForBinding(finalSchema);
  if (isRecord(linkSchema)) {
    if (isCellScope(linkSchema.scope)) {
      scope = linkSchema.scope;
    }
  }

  return {
    ...link,
    path: [...path],
    scope,
    ...(linkSchema !== undefined && { schema: linkSchema }),
  };
};

const sanitizeAliasSchemaForBinding = (schema: JSONSchema): JSONSchema =>
  // Compiled aliases retain asCell for schema fidelity. Live redirects use link
  // schemas without cell wrappers so scoped asCell entries do not stamp the
  // redirect link's own scope and bypass stored argument links.
  sanitizeSchemaForLinks(schema, KeepAsCell.OnlyStream);

const descriptorForPartialCauseAlias = (
  partialCause: JSONValue,
  descriptors: readonly DerivedInternalCellDescriptor[] | undefined,
): DerivedInternalCellDescriptor | undefined => {
  const descriptor = descriptors?.find((descriptor) =>
    deepEqual(descriptor.partialCause, partialCause)
  );
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
  // Result-write plumbing is machinery (machineryRead): the redirect walk
  // and the diff reads at plumbing containers must not consume `*`-path
  // membership templates (template-population §6, the SC-8 machinery-read
  // boundary) — the action body's own reads carry the taint. Every caller
  // is the runner's result plumbing; no user code runs inside.
  tx.runWithAmbientReadMeta(
    machineryRead,
    () =>
      sendValueToBindingInner(
        tx,
        cell,
        argumentCellLink,
        binding,
        value,
        options,
      ),
  );
}

function sendValueToBindingInner<T>(
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
  // Handle both legacy $alias format and new sigil link format. `$alias` is
  // only meaningful here because `binding` comes from a Pattern object;
  // `isWriteRedirectLink` itself no longer matches it.
  if (isWriteRedirectLink(binding) || isAliasBinding(binding)) {
    if (isAliasBinding(binding)) {
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
        )!;
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
        const newValue = createSigilLinkFromParsedLink(
          valueLink,
        ) as FabricValue;
        // Skip the write when the redirect already holds this exact link. Raw
        // builtins (ifElse/when/unless/map/...) re-run and re-send their result
        // whenever their inputs change, but the output binding points at a
        // cause-stable result cell, so the link is usually unchanged. The read
        // is an internal write-elision decision: kept out of scheduling
        // (`ignoreReadForScheduling`) and CFC taint (`internalVerifierRead`),
        // and compared with the `Fabric`-aware `valueEqual`.
        const current = tx.readValueOrThrow(bindingLink, {
          meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
        });
        if (!valueEqual(current, newValue)) {
          tx.writeValueOrThrow(bindingLink, newValue);
        }
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
        sendValueToBindingInner(
          tx,
          cell,
          argumentCellLink,
          binding[i],
          value[i],
          options,
        );
      }
    }
    // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this path
    // today, but will in the not-too-distant future; at that point this
    // guard-less walk keys a live `FabricValue` against the binding shape (a
    // `FabricPrimitive` is decomposed, a `FabricInstance` is walked by internal
    // slots rather than codec contents). Mark ahead of that.
  } else if (isRecord(binding) && isRecord(value)) {
    for (const key of Object.keys(binding)) {
      if (key in value) {
        sendValueToBindingInner(
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
    // `Object.is`, not `===`: a constant `NaN` binding legitimately matches a
    // produced `NaN`, and `0` vs `-0` is a genuine mismatch.
    if (!Object.is(binding, value)) {
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
 * @param argumentCellLink - The link to the argument cell or undefined if not available.
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
  argumentCellLink: NormalizedFullLink | undefined,
  resultCell: AnyCell<unknown>,
  options?: UnwrapOneLevelOptions,
): T {
  const resultCellLink = resultCell.getAsNormalizedFullLink();

  function convert(
    binding: unknown,
    targetSchema: JSONSchema | undefined,
  ): unknown {
    if (isAliasBinding(binding)) {
      const { defer: optDefer, ...aliasRest } = { ...binding.$alias };
      const defer = optDefer ?? 0;
      if (defer > 0) {
        return {
          $alias: { ...aliasRest, ...((defer > 1) && { defer: defer - 1 }) },
        };
      }
      const alias = binding.$alias;
      if (alias.partialCause !== undefined) {
        // If we've provided derivedInternalCells, we can look up this alias
        const descriptor = descriptorForPartialCauseAlias(
          alias.partialCause,
          options?.derivedInternalCells,
        );
        // If we're providing derivedInternalCells, and we didn't find our
        // cell, we should throw an error.
        if (
          descriptor === undefined &&
          options?.derivedInternalCells !== undefined
        ) {
          throw new Error(
            `Unknown derived internal cell with partial cause: ${
              JSON.stringify(alias.partialCause)
            }`,
          );
        }
        // For manually constructed patterns, we don't always have
        // derivedInternalCells, so we won't find a descriptor.
        // In that case, we'll just create a link with the partial
        // cause and hope it gets resolved later.
        // Without the derivedInternalCells, we also won't be able to set the
        // initial values.
        const link = descriptor !== undefined
          ? getDerivedInternalCellLink(resultCell, descriptor)
          : getDerivedInternalCellLink(resultCell, {
            partialCause: alias.partialCause,
            scope: alias.scope,
          });
        const path = alias.path;
        const sourceSchema = alias.schema !== undefined
          ? sanitizeAliasSchemaForBinding(alias.schema)
          : link.schema !== undefined
          ? cfc.schemaAtPath(link.schema, path)
          : undefined;
        return createSigilLinkFromParsedLink(
          scopedLinkForPath(cfc, link, path, targetSchema ?? sourceSchema),
          { includeSchema: true, overwrite: "redirect" },
        );
      } else {
        // Resolve the special values for "argument" and "result" — the only
        // `cell` values isAliasBinding admits.
        const link = alias.cell === "argument"
          ? argumentCellLink
          : resultCellLink;
        if (link === undefined) {
          throw new Error(
            "Cannot bind argument alias: no argument cell link available",
          );
        }
        const path = alias.path;
        // we might have a schema in the alias, but if not, we may have one
        // in the link (from the pattern)
        const sourceSchema = alias.schema !== undefined
          ? sanitizeAliasSchemaForBinding(alias.schema)
          : link.schema !== undefined
          ? cfc.schemaAtPath(link.schema, path)
          : undefined;
        const authoredRootSchema = alias.cell === "argument"
          ? options?.sourceSchemas?.argument
          : undefined;
        return createSigilLinkFromParsedLink(
          foldDeclaredScopeIntoLinkSchema(
            cfc,
            scopedLinkForPath(cfc, link, path, targetSchema ?? sourceSchema),
            authoredRootSchema,
            path,
          ),
          { includeSchema: true, overwrite: "redirect" },
        );
      }
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
      // Carry the derivation link (trust + content-addressed entry ref) onto
      // the bound copy so a pattern value re-bound here still resolves its
      // `{ identity, symbol }` and stays trusted.
      if (isPattern(binding)) noteDerivedCopy(result, binding);
      return result;
    } else return binding;
  }
  return convert(binding, options?.targetSchema) as T;
}

/**
 * Compute the set of TOP-LEVEL argument keys an argument schema declares
 * OPAQUE — i.e. carrying an `asCell: ["opaque"]` marker. Distinguished from
 * `asCell: ["cell"]` (a potentially value-read cell reference). ifElse marks
 * its pass-through `ifTrue`/`ifFalse` branches opaque so they can be dropped
 * from the node's declared reads.
 *
 * Returns an empty set when the schema declares no opaque keys (the common
 * case), so callers can cheaply skip the filter.
 */
export function opaqueArgumentKeys(
  argumentSchema: JSONSchema | undefined,
): Set<string> {
  const keys = new Set<string>();
  if (!isRecord(argumentSchema)) return keys;
  const properties = argumentSchema.properties;
  if (!isRecord(properties)) return keys;
  for (const [key, propSchema] of Object.entries(properties)) {
    const isOpaque = ContextualFlowControl.getAsCellValues(
      propSchema as JSONSchema,
    ).some((entry) => ContextualFlowControl.getAsCellKind(entry) === "opaque");
    if (isOpaque) keys.add(key);
  }
  return keys;
}

/**
 * Traverses binding and returns all cells reachable through write redirects.
 *
 * @param binding - The binding to traverse.
 * @param baseCell - The base cell to use for resolving links.
 * @param options - Optional configuration.
 * @param options.skipTopLevelKeys - Top-level argument keys to skip entirely.
 *   Used to drop OPAQUE forwarded references (e.g. ifElse's
 *   `ifTrue`/`ifFalse` branches) so they don't become declared reads that pull
 *   their (possibly unselected) writer. The opacity marker lives on the
 *   module's argument schema (link schemas are sanitized of `asCell` when a
 *   sigil link is created — see `sanitizeSchemaForLinks` — so it cannot be
 *   read off the resolved link), hence keying off the binding KEY here.
 * @returns All links reachable through write redirects.
 */
export function findAllWriteRedirectCells<T>(
  binding: unknown,
  baseCell: AnyCell<T>,
  options?: { skipTopLevelKeys?: ReadonlySet<string> },
): NormalizedFullLink[] {
  const skipTopLevelKeys = options?.skipTopLevelKeys;
  const seen: NormalizedFullLink[] = [];
  // `baseCell` is only used for link resolution (runtime/tx/parseLink), which
  // does not depend on the cell's value type, so accept any cell. This lets the
  // redirect-chain recursion re-base onto the resolved `linkCell` (a
  // `Cell<unknown>`) rather than the original typed base.
  function find(binding: unknown, baseCell: AnyCell<unknown>): void {
    if (isAliasBinding(binding)) {
      // Callers unwrap bindings (unwrapOneLevelAndBindtoDoc) before walking,
      // so a surviving `$alias` belongs to a nested level — it just crossed
      // its `defer` boundary, or sits inside an embedded Pattern value —
      // and is not part of this level's read/write surface.
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
      const link = parseLink(binding, baseCell.getAsNormalizedFullLink());
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
    } else if (isPattern(binding)) {
      // Embedded Pattern values are opaque here: their `$alias` records and
      // sigil links are the embedded pattern's own binding vocabulary,
      // interpreted only when THAT pattern is instantiated (`defer`
      // bookkeeping positions its aliases for that moment). Walking into them
      // would declare reads at the wrong nesting level.
      return;
    } else if (Array.isArray(binding)) {
      // If the binding is an array, recurse into each element.
      for (const value of binding) find(value, baseCell);
      // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
      // path today, but will in the not-too-distant future; at that point this
      // guard-less `isRecord`-walk fails (a `FabricPrimitive` is decomposed, a
      // `FabricInstance` is walked by internal slots rather than codec
      // contents). Mark ahead of that.
    } else if (isRecord(binding) && !isCellLink(binding)) {
      // If the binding is an object, recurse into each value.
      for (const value of Object.values(binding)) find(value, baseCell);
    }
  }
  if (
    skipTopLevelKeys !== undefined && skipTopLevelKeys.size > 0 &&
    isRecord(binding) && !isCellLink(binding) && !isAliasBinding(binding)
  ) {
    // Drop the named top-level argument keys (opaque forwarded references)
    // before traversing — they must not contribute to declared reads.
    for (const [key, value] of Object.entries(binding)) {
      if (skipTopLevelKeys.has(key)) continue;
      find(value, baseCell);
    }
  } else {
    find(binding, baseCell);
  }
  return seen;
}
