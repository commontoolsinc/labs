/** Traverses visible view nodes under the same read schemas as their components. */

import type { JSONSchema } from "@commonfabric/api";
import type { ScopeKeyIdentity, ViewInterest } from "@commonfabric/memory/v2";
import { PathKeyMap } from "@commonfabric/utils/path-key-map";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

import { type Cell, deepTraverse, isCell } from "./cell.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  componentReadContracts,
  componentReadSchema,
} from "./component-read-contract.ts";
import { type NormalizedFullLink, toMemorySpaceAddress } from "./link-utils.ts";
import { sortAndCompactPaths } from "./reactive-dependencies.ts";
import type { Runtime } from "./runtime.ts";
import { txToReactivityLog } from "./scheduler/reactivity.ts";
import { SchedulerTriggerIndex } from "./scheduler/trigger-index.ts";
import type { Action } from "./scheduler/types.ts";
import { rendererVDOMSchema } from "./schemas.ts";
import { UI } from "./shared.ts";
import type {
  IMemorySpaceAddress,
  StorageNotification,
} from "./storage/interface.ts";

/** Observed renderer reads, directly writable bindings, and visible handlers. */
export type ViewRenderReads = {
  reads: IMemorySpaceAddress[];
  shallowReads: IMemorySpaceAddress[];
  bindings: IMemorySpaceAddress[];
  streams: NormalizedFullLink[];
};

/**
 * What the walk found at one visible cell, read under the renderer's schema:
 * the reads its own node made, the bindings and handlers it declared, and
 * the cells its node holds, which the walk visits in turn.
 */
type WalkedCell = ViewRenderReads & {
  children: NormalizedFullLink[];
  /** The reader the memo's index knows this cell's reads by. */
  reader: Action;
};

/**
 * Keeps what a walk found at each visible cell, under one viewing identity,
 * until a storage notification changes a document that cell read. A walk
 * given the memo reads only the cells it holds nothing for, and takes the
 * rest from it, so a change to a few values the UI shows costs the walk
 * those cells rather than the whole tree. The index matches changes the way
 * the scheduler matches an action's reads: by path, under the identity's
 * scoped documents.
 */
export class ViewRenderWalkMemo {
  #index: SchedulerTriggerIndex;
  #entries = new Map<string, WalkedCell>();
  #keysByReader = new Map<Action, string>();
  #walked = 0;

  constructor(identity: ScopeKeyIdentity) {
    this.#index = new SchedulerTriggerIndex(() => identity);
  }

  /** The cells walked, as opposed to replayed, since construction. */
  get accessForTestingOnly(): {
    readonly walked: number;
    readonly size: number;
  } {
    return { walked: this.#walked, size: this.#entries.size };
  }

  get(key: string): WalkedCell | undefined {
    return this.#entries.get(key);
  }

  set(key: string, cell: WalkedCell): void {
    this.#walked++;
    this.#entries.set(key, cell);
    this.#keysByReader.set(cell.reader, key);
    this.#index.addActionReads(
      cell.reader,
      sortAndCompactPaths(cell.reads),
      sortAndCompactPaths(cell.shallowReads, false),
    );
  }

  /** Forgets every cell whose reads the notification's changes touch. */
  notify(notification: StorageNotification): void {
    if (this.#entries.size === 0) return;
    if (notification.type === "reset") {
      this.clear();
      return;
    }
    for (const change of notification.changes) {
      const { triggeredActions } = this.#index.collectTriggeredActionsForChange(
        notification.space,
        change,
      );
      for (const reader of triggeredActions) {
        const key = this.#keysByReader.get(reader);
        if (key === undefined) continue;
        this.#keysByReader.delete(reader);
        this.#entries.delete(key);
      }
    }
    // Readers forgotten above stay in the index until it is rebuilt; a
    // trigger for one finds no key and is ignored.
    if (this.#entries.size === 0) this.#index.clear();
  }

  clear(): void {
    this.#entries.clear();
    this.#keysByReader.clear();
    this.#index.clear();
  }
}

/**
 * Reads only the visible tree and its component-declared property
 * projections. With a memo, a cell the memo holds is taken from it; every
 * other cell is read and recorded there.
 */
export function collectViewRenderReads(
  runtime: Runtime,
  space: NormalizedFullLink["space"],
  view: ViewInterest,
  identity: ScopeKeyIdentity,
  memo?: ViewRenderWalkMemo,
): ViewRenderReads {
  const reads: IMemorySpaceAddress[] = [];
  const shallowReads: IMemorySpaceAddress[] = [];
  const bindings: IMemorySpaceAddress[] = [];
  const streams: NormalizedFullLink[] = [];
  const visited = new PathKeyMap<boolean>();
  // A document two cells read is reported once, as one transaction's log
  // reports it; the consumers sort and compact what they need themselves.
  const seenReads = new PathKeyMap<boolean>();
  const seenShallowReads = new PathKeyMap<boolean>();
  const addRead = (
    into: IMemorySpaceAddress[],
    seen: PathKeyMap<boolean>,
    read: IMemorySpaceAddress,
  ) => {
    const key = [read.space, read.scope ?? "space", read.id, ...read.path];
    if (seen.has(key)) return;
    seen.set(key, true);
    into.push(read);
  };

  function visitCell(link: NormalizedFullLink): void {
    const key = [link.space, link.scope, link.id, ...link.path];
    if (visited.has(key)) return;
    visited.set(key, true);
    const memoKey = JSON.stringify(key);
    let cell = memo?.get(memoKey);
    if (cell === undefined) {
      cell = walkCell(runtime, space, link, identity);
      memo?.set(memoKey, cell);
    }
    for (const read of cell.reads) addRead(reads, seenReads, read);
    for (const read of cell.shallowReads) {
      addRead(shallowReads, seenShallowReads, read);
    }
    for (const binding of cell.bindings) bindings.push(binding);
    for (const stream of cell.streams) streams.push(stream);
    for (const child of cell.children) visitCell(child);
  }

  for (const root of view.query.roots) {
    visitCell({
      space,
      id: root.id as NormalizedFullLink["id"],
      scope: root.scope ?? "space",
      path: root.selector.path,
    });
  }
  return { reads, shallowReads, bindings, streams };
}

/**
 * Reads one visible cell's node under the renderer's schema, in a
 * transaction of its own so that the reads recorded are that node's alone,
 * and collects the cells the node holds without reading them.
 */
function walkCell(
  runtime: Runtime,
  space: NormalizedFullLink["space"],
  link: NormalizedFullLink,
  identity: ScopeKeyIdentity,
): WalkedCell {
  const tx = runtime.readTx();
  tx.tx.scopeKeyIdentity = identity;
  const bindings: IMemorySpaceAddress[] = [];
  const streams: NormalizedFullLink[] = [];
  const children: NormalizedFullLink[] = [];
  const seenObjects = new WeakSet<object>();

  function readProperty(
    cell: Cell<unknown>,
    schema: JSONSchema | undefined,
  ): void {
    const value = cell.asSchema(schema).get({ traverseCells: true });
    if (schema === undefined || ContextualFlowControl.isTrueSchema(schema)) {
      deepTraverse(value);
    }
  }

  function visit(value: unknown): void {
    if (isCell(value)) {
      children.push(value.getAsNormalizedFullLink());
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
        const event = name.startsWith("on");
        const property = binding ? name.slice(1) : name;
        // A prop that is itself a nested render's reference is read by that
        // render, which the walk does not follow.
        const contract = componentReadContracts[value.name]?.[property];
        const schema = contract?.renders?.some((path) => path.length === 0)
          ? undefined
          : contract?.schema;
        if (binding || event) {
          const slot = isCell(prop) ? prop.withTx(tx) : propsCell?.key(name);
          if (slot === undefined) continue;
          const source = slot.resolveAsCell();
          const link = source.getAsNormalizedFullLink();
          streams.push(link);
          if (binding) bindings.push(toMemorySpaceAddress(link));
          if (schema !== undefined) {
            readProperty(
              source,
              componentReadSchema(value.name, property, link.schema, props),
            );
          }
        } else if (isCell(prop)) {
          readProperty(prop.withTx(tx), schema ?? true);
        } else if (
          name !== "style" && isObjectOrArray(prop)
        ) {
          // The worker renderer deep-resolves ordinary object/array props.
          if (propsCell !== undefined) readProperty(propsCell.key(name), true);
        }
      }
    }
    if (isCell(value.children)) {
      const childNodes = (value.children as Cell<unknown>).withTx(tx).get();
      if (Array.isArray(childNodes)) {
        for (const child of childNodes) visit(child);
      }
    } else visit(value.children);
  }

  try {
    visit(
      runtime.getCellFromLink(
        { ...link, space },
        rendererVDOMSchema,
        tx,
      ).get(),
    );
    const log = txToReactivityLog(tx);
    return {
      reads: log.reads,
      shallowReads: log.shallowReads,
      bindings,
      streams,
      children,
      reader: () => {},
    };
  } finally {
    tx.clearReadOnly?.();
    tx.abort("view traversal complete");
  }
}
