/** Traverses visible view nodes under the same read schemas as their components. */

import type { ScopeKeyIdentity, ViewInterest } from "@commonfabric/memory/v2";
import { PathKeyMap } from "@commonfabric/utils/path-key-map";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { type Cell, isCell } from "./cell.ts";
import {
  componentReadContracts,
  componentReadSchema,
} from "./component-read-contract.ts";
import { type NormalizedFullLink, toMemorySpaceAddress } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import { txToReactivityLog } from "./scheduler/reactivity.ts";
import { rendererVDOMSchema } from "./schemas.ts";
import { UI } from "./shared.ts";
import type { IMemorySpaceAddress } from "./storage/interface.ts";

/** Observed renderer reads, directly writable bindings, and visible handlers. */
export type ViewRenderReads = {
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  bindings: IMemorySpaceAddress[];
  streams: NormalizedFullLink[];
};

/** Reads only the visible tree and its component-declared property projections. */
export function collectViewRenderReads(
  runtime: Runtime,
  space: NormalizedFullLink["space"],
  view: ViewInterest,
  identity: ScopeKeyIdentity,
): ViewRenderReads {
  const tx = runtime.readTx();
  tx.tx.scopeKeyIdentity = identity;
  const bindings: IMemorySpaceAddress[] = [];
  const streams: NormalizedFullLink[] = [];
  const visited = new PathKeyMap<boolean>();
  const seenObjects = new WeakSet<object>();

  function visit(value: unknown): void {
    if (isCell(value)) {
      const link = value.getAsNormalizedFullLink();
      const key = [link.space, link.scope, link.id, ...link.path];
      if (visited.has(key)) return;
      visited.set(key, true);
      visit(value.withTx(tx).asSchema(rendererVDOMSchema).get());
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isObjectNotArray(value) || seenObjects.has(value)) return;
    seenObjects.add(value);
    if (UI in value) visit(value[UI]);
    if (value.type !== "vnode" || typeof value.name !== "string") return;
    const propsCell = isCell(value.props) ? value.props.withTx(tx) : undefined;
    const props = propsCell === undefined ? value.props : propsCell.get();
    if (isObjectNotArray(props)) {
      for (const [name, prop] of Object.entries(props)) {
        const binding = name.startsWith("$");
        const event = name.startsWith("on") || name.startsWith("@");
        const property = binding ? name.slice(1) : name;
        const schema = componentReadContracts[value.name]?.[property];
        if (binding || event) {
          const slot = isCell(prop) ? prop.withTx(tx) : propsCell?.key(name);
          if (slot === undefined) continue;
          const source = slot.resolveAsCell();
          const link = source.getAsNormalizedFullLink();
          streams.push(link);
          if (binding) bindings.push(toMemorySpaceAddress(link));
          if (schema !== undefined) {
            source.asSchema(
              componentReadSchema(value.name, property, link.schema, props),
            ).get({ traverseCells: true });
          }
        } else if (isCell(prop)) {
          prop.withTx(tx).asSchema(schema ?? true).get({ traverseCells: true });
        } else if (
          name !== "style" && prop !== null && typeof prop === "object"
        ) {
          // The worker renderer deep-resolves ordinary object/array props.
          propsCell?.key(name).asSchema(true).get({ traverseCells: true });
        }
      }
    }
    if (isCell(value.children)) {
      const children = (value.children as Cell<unknown>).withTx(tx).get();
      if (Array.isArray(children)) {
        for (const child of children) visit(child);
      }
    } else visit(value.children);
  }

  try {
    for (const root of view.query.roots) {
      visit(runtime.getCellFromLink(
        {
          space,
          id: root.id as NormalizedFullLink["id"],
          scope: root.scope ?? "space",
          path: root.selector.path,
        },
        rendererVDOMSchema,
        tx,
      ));
    }
    const log = txToReactivityLog(tx);
    return {
      reads: log.reads,
      shallowReads: log.shallowReads,
      bindings,
      streams,
    };
  } finally {
    tx.clearReadOnly?.();
    tx.abort("view traversal complete");
  }
}
