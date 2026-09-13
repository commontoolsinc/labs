import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";

import type { CellHandle, ClientCellValue } from "../src/cell-handle.ts";

// The assertions in this file are made when it is type-checked, which the
// repository's type check does for this directory, not when it runs. The
// carrier below is a function that is never called: each assignment in it
// pins a direction the type admits.

/**
 * The recursive shape `ClientCellValue` names, written out: a `FabricValue`,
 * a `CellHandle`, or a read-only tree of either.
 */
type WrittenOutClientCellValue =
  | FabricValue
  | CellHandle<unknown>
  | readonly WrittenOutClientCellValue[]
  | { readonly [key: string]: WrittenOutClientCellValue };

declare const writtenOut: WrittenOutClientCellValue;
declare const handle: CellHandle<unknown>;
declare const handleArray: readonly CellHandle<unknown>[];
declare const handleRecord: { readonly [key: string]: CellHandle<unknown> };

/** Carrier for the `ClientCellValue` checks. */
function clientCellValueTypeChecks() {
  // The written-out recursion is admitted, and so is a handle at the top and
  // inside each container.
  const fromWrittenOut: ClientCellValue = writtenOut;
  const bare: ClientCellValue = handle;
  const inArray: ClientCellValue = handleArray;
  const inRecord: ClientCellValue = handleRecord;

  return { fromWrittenOut, bare, inArray, inRecord };
}

describe("ClientCellValue", () => {
  it("admits the written-out recursion over `FabricValue` and `CellHandle`", () => {
    // The type checker decides the claim; at run time only the carrier is
    // observable.
    expect(typeof clientCellValueTypeChecks).toBe("function");
  });
});
