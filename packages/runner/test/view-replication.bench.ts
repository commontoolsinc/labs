/** Measures selection through ordered dependency chains and unrelated nodes. */

import { expect } from "@std/expect";

import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  selectViewData,
  type ViewExecutionNode,
} from "../src/view-replication.ts";

function address(id: string): NormalizedFullLink & IMemorySpaceAddress {
  return {
    space: "did:key:z6Mk-view-bench",
    id: `of:${id}`,
    type: "application/json",
    scope: "space",
    path: [],
  };
}

for (const size of [100, 300, 1000]) {
  const nodes: ViewExecutionNode[] = [];
  for (let index = 0; index < size; index++) {
    for (const branch of ["visible", "hidden"]) {
      const writes = [address(`${branch}-${index + 1}`)];
      nodes.push({
        id: `${branch}-${index}`,
        piece: address("piece"),
        kind: "computation",
        log: {
          reads: [address(`${branch}-${index}`), address("side-input")],
          shallowReads: [],
          writes,
        },
        writes,
      });
    }
  }
  Deno.bench({
    name: `${size} visible and ${size} hidden nodes`,
    group: "view selection chain",
    fn(b) {
      b.start();
      const selection = selectViewData(
        nodes,
        [address(`visible-${size}`)],
        [address("visible-0")],
        new Set(),
      );
      b.end();
      expect(selection.actions.length).toBe(size);
      expect(selection.actions.every((id) => id.startsWith("visible-"))).toBe(
        true,
      );
    },
  });
}
