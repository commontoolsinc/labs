import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

import { resolveLink } from "../src/link-resolution.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

// Benchmarks using Deno.bench
Deno.bench("followWriteRedirects with simple alias", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const testCell = runtime.getCell<{ value: number }>(
    space,
    "bench-simple-alias",
    undefined,
    tx,
  );
  testCell.set({ value: 42 });
  const binding = { $alias: { path: ["value"] } };

  resolveLink(tx, parseLink(binding, testCell)!, "writeRedirect");

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("followWriteRedirects with nested aliases (5 levels)", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const depth = 5;
  const cells: any[] = [];

  for (let i = 0; i < depth; i++) {
    const cell = runtime.getCell<any>(
      space,
      `bench-nested-${i}`,
      undefined,
      tx,
    );
    cells.push(cell);
  }

  cells[depth - 1].set({ finalValue: 999 });

  for (let i = depth - 2; i >= 0; i--) {
    cells[i].setRaw({
      next: cells[i + 1].key("finalValue").getAsWriteRedirectLink(),
    });
  }

  const binding = { $alias: { path: ["next"] } };
  resolveLink(tx, parseLink(binding, cells[0])!, "writeRedirect");

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("resolveLink with direct reference", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const cell = runtime.getCell<{ id: number; data: string }>(
    space,
    "bench-resolve",
    undefined,
    tx,
  );
  cell.set({ id: 1, data: "Test data" });

  resolveLink(tx, cell.getAsNormalizedFullLink());

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("circular reference navigation (A->B->A->value)", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<{ b: any; value: string }>(
    space,
    "bench-circular-A",
    undefined,
    tx,
  );
  const cellB = runtime.getCell<{ a: any; value: string }>(
    space,
    "bench-circular-B",
    undefined,
    tx,
  );

  cellA.set({ b: cellB, value: "A" });
  cellB.set({ a: cellA, value: "B" });

  cellA.key("b").key("a").key("value").get();

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("complex path navigation (6 hops through 3 cells)", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<{ b: any; c: any; data: { value: number } }>(
    space,
    "bench-complex-A",
    undefined,
    tx,
  );
  const cellB = runtime.getCell<{ a: any; c: any; data: { value: number } }>(
    space,
    "bench-complex-B",
    undefined,
    tx,
  );
  const cellC = runtime.getCell<{ a: any; b: any; data: { value: number } }>(
    space,
    "bench-complex-C",
    undefined,
    tx,
  );

  cellA.set({ b: cellB, c: cellC, data: { value: 100 } });
  cellB.set({ a: cellA, c: cellC, data: { value: 200 } });
  cellC.set({ a: cellA, b: cellB, data: { value: 300 } });

  cellA.key("b").key("c").key("a").key("c").key("data").key("value").get();

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("array element resolution in circular structures", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<{ items: any[]; name: string }>(
    space,
    "bench-array-A",
    undefined,
    tx,
  );
  const cellB = runtime.getCell<{ parent: any; index: number }>(
    space,
    "bench-array-B",
    undefined,
    tx,
  );
  const cellC = runtime.getCell<{ parent: any; index: number }>(
    space,
    "bench-array-C",
    undefined,
    tx,
  );

  cellA.set({ items: [cellB, cellC], name: "Array Parent" });
  cellB.set({ parent: cellA, index: 0 });
  cellC.set({ parent: cellA, index: 1 });

  cellA.key("items").key(0).key("parent").key("items").key(1).key("index")
    .get();

  tx.commit();
  runtime.dispose();
  storageManager.close();
});

Deno.bench("resolveLink with infinitely growing path (A->A/foo)", () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    blobbyServerUrl: import.meta.url,
    storageManager,
  });
  const tx = runtime.edit();

  const cellA = runtime.getCell<any>(
    space,
    "bench-growing-path",
    undefined,
    tx,
  );

  // Create a link from A to A/foo using setRaw to bypass cycle detection on write
  cellA.setRaw(cellA.key("foo").getAsLink());

  // This should detect the growing path cycle and return the empty document
  const resolved = resolveLink(tx, cellA.getAsNormalizedFullLink());

  // Verify it returned the empty document
  if (resolved.id !== "data:application/json,{}") {
    throw new Error("Expected empty document for growing path cycle");
  }

  tx.commit();
  runtime.dispose();
  storageManager.close();
});
