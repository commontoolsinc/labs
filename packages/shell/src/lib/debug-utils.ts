/**
 * Debug utilities for inspecting cell values from the browser console.
 *
 * Exposed on `globalThis.commontools` as:
 *   - readCell(options?)
 *   - readArgumentCell(options?)
 *   - subscribeToCell(options?)
 */

import { CellHandle } from "@commontools/runtime-client";
import type { RuntimeClient, CellRef } from "@commontools/runtime-client";
import type { DID } from "@commontools/identity";

interface DebugCellOptions {
  /** Space DID — defaults to current shell space */
  space?: string;
  /** Piece CID — defaults to piece from URL bar */
  did?: string;
  /** Path into cell — defaults to [] */
  path?: string[];
}

function getDefaultDid(): string {
  const segments = window.location.pathname.split("/");
  // URL format: /<spaceName>/<pieceId>
  return segments[2] ?? "";
}

function buildCellRef(
  space: string,
  did: string,
  path: string[],
): CellRef {
  return {
    id: `of:${did}`,
    space: space as DID,
    path,
    type: "application/json",
  } as CellRef;
}

export function createDebugUtils(
  getSpace: () => DID | undefined,
  getRt: () => RuntimeClient | undefined,
) {
  async function readCell(options?: DebugCellOptions): Promise<unknown> {
    const rt = getRt();
    if (!rt) {
      console.error("[debug] No runtime available");
      return undefined;
    }

    const space = (options?.space ?? getSpace()) as string;
    if (!space) {
      console.error("[debug] No space available");
      return undefined;
    }

    const did = options?.did ?? getDefaultDid();
    if (!did) {
      console.error("[debug] No piece DID — navigate to a piece first or pass { did }");
      return undefined;
    }

    const path = options?.path ?? [];
    const ref = buildCellRef(space, did, path);

    console.log("[debug] readCell ref:", ref);
    const cell = new CellHandle(rt, ref);
    const value = await cell.sync();
    console.log("[debug] readCell value:", value);
    return value;
  }

  async function readArgumentCell(options?: DebugCellOptions): Promise<unknown> {
    const path = ["argument", ...(options?.path ?? [])];
    return readCell({ ...options, path });
  }

  function subscribeToCell(options?: DebugCellOptions): (() => void) | undefined {
    const rt = getRt();
    if (!rt) {
      console.error("[debug] No runtime available");
      return undefined;
    }

    const space = (options?.space ?? getSpace()) as string;
    if (!space) {
      console.error("[debug] No space available");
      return undefined;
    }

    const did = options?.did ?? getDefaultDid();
    if (!did) {
      console.error("[debug] No piece DID — navigate to a piece first or pass { did }");
      return undefined;
    }

    const path = options?.path ?? [];
    const ref = buildCellRef(space, did, path);

    console.log("[debug] subscribeToCell ref:", ref);
    const cell = new CellHandle(rt, ref);
    const cancel = cell.subscribe((value) => {
      console.log(`[debug] cell update [${new Date().toISOString()}]:`, value);
    });

    console.log("[debug] Subscribed. Call the returned function to cancel.");
    return cancel;
  }

  return { readCell, readArgumentCell, subscribeToCell };
}
