import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { createCell } from "../src/cell.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

Deno.test("pattern factory .asScope() sets child pattern result scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern(() => ({ value: "child" }));
    const Root = pattern(() => ({
      child: Child.asScope("user")({}),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern factory asScope child result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const childLink = parseLink(result.key("child").getRaw(), result);
    assertEquals(childLink?.scope, "user");
    assertEquals(
      runtime.getCellFromLink(childLink!).getSourceCell()
        ?.getAsNormalizedFullLink().scope,
      "user",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("pattern result schema scope overrides factory .asScope()", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;

    const Child = pattern(
      () => ({ value: "child" }),
      { type: "object", properties: {} },
      {
        type: "object",
        properties: { value: { type: "string" } },
        scope: "session",
      },
    );
    const Root = pattern(() => ({
      child: Child.asScope("user")({}),
    }));

    const resultCell = runtime.getCell(
      space,
      "pattern result schema scope override",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await runtime.idle();
    await result.pull();

    const childLink = parseLink(result.key("child").getRaw(), result);
    assertEquals(childLink?.scope, "session");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("broad computed output links to narrower scoped result", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const baseSecret = runtime.getCell<number>(
      space,
      "user scoped computation input",
      undefined,
      tx,
    );
    const secret = createCell(
      runtime,
      { ...baseSecret.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    secret.set(41);

    const Root = pattern<{ secret: number }>(({ secret }) => ({
      value: lift(
        { type: "number" },
        { type: "number" },
        (x: number) => x + 1,
      )(secret),
    }));

    const resultCell = runtime.getCell(
      space,
      "broad computed output links to narrower scoped result",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { secret }, resultCell);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const sourceCell = result.getSourceCell();
    const rawValue = sourceCell?.key("internal").key("value").getRaw();
    const valueLink = parseLink(rawValue, sourceCell!);
    assertEquals(valueLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, 42);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("map keeps outer list scope and narrows per-element result cells", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "map scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const increment = lift(
      { type: "number" },
      { type: "number" },
      (x: number) => x + 1,
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      mapped: values.map((value) => increment(value)),
    }));

    const resultCell = runtime.getCell(
      space,
      "map keeps outer list scope and narrows per-element result cells",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawMapped = result.key("mapped").getRaw();
    const mappedLink = parseLink(rawMapped, result);
    assertEquals(mappedLink?.scope, "space");

    const mappedResultCell = runtime.getCellFromLink(mappedLink!);
    const mappedRaw = mappedResultCell.getRaw();
    const itemLink = Array.isArray(mappedRaw)
      ? parseLink(mappedRaw[0], mappedResultCell)
      : undefined;
    assertEquals(itemLink?.scope, "user");
    assertEquals(result.key("mapped").get() as unknown, [21]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("filter narrows output list when scoped element controls cardinality", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "filter scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const positive = lift(
      { type: "number" },
      { type: "boolean" },
      (x: number) => x > 0,
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      filtered: values.filter((value) => positive(value)),
    }));

    const resultCell = runtime.getCell(
      space,
      "filter narrows output list when scoped element controls cardinality",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawFiltered = result.key("filtered").getRaw();
    const filteredLink = parseLink(rawFiltered, result);
    assertEquals(filteredLink?.scope, "user");
    assertEquals(result.key("filtered").get() as unknown, [20]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("flatMap narrows output list when scoped element controls cardinality", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const itemBase = runtime.getCell<number>(
      space,
      "flatMap scoped item input",
      undefined,
      tx,
    );
    const item = createCell<number>(
      runtime,
      { ...itemBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    item.set(20);

    const expand = lift(
      { type: "number" },
      { type: "array", items: { type: "number" } },
      (x: number) => [x, x + 1],
    );
    const Root = pattern<{ values: number[] }>(({ values }) => ({
      expanded: values.flatMap((value) => expand(value)),
    }));

    const resultCell = runtime.getCell(
      space,
      "flatMap narrows output list when scoped element controls cardinality",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { values: [item as any] }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawExpanded = result.key("expanded").getRaw();
    const expandedLink = parseLink(rawExpanded, result);
    assertEquals(expandedLink?.scope, "user");
    assertEquals(result.key("expanded").get() as unknown, [20, 21]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("ifElse output follows condition scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { ifElse, pattern } = createTrustedBuilder(runtime).commonfabric;
    const conditionBase = runtime.getCell<boolean>(
      space,
      "ifElse user scoped condition",
      undefined,
      tx,
    );
    const condition = createCell<boolean>(
      runtime,
      { ...conditionBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    condition.set(true);

    const Root = pattern<{ condition: boolean }>(({ condition }) => ({
      value: ifElse(condition, "yes", "no"),
    }));

    const resultCell = runtime.getCell(
      space,
      "ifElse output follows condition scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { condition }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawValue = result.key("value").getRaw();
    const valueLink = parseLink(rawValue, result);
    assertEquals(valueLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, "yes");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("when keeps condition scope while selecting narrower value link", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { pattern, when } = createTrustedBuilder(runtime).commonfabric;
    const valueBase = runtime.getCell<string>(
      space,
      "when user scoped selected value",
      undefined,
      tx,
    );
    const value = createCell<string>(
      runtime,
      { ...valueBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    value.set("selected");

    const Root = pattern<{ value: string }>(({ value }) => ({
      value: when(true, value),
    }));

    const resultCell = runtime.getCell(
      space,
      "when keeps condition scope while selecting narrower value link",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { value }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const rawValue = result.key("value").getRaw();
    const whenLink = parseLink(rawValue, result);
    assertEquals(whenLink?.scope, "space");

    const whenCell = runtime.getCellFromLink(whenLink!);
    const selectedLink = parseLink(whenCell.getRaw(), whenCell);
    assertEquals(selectedLink?.scope, "user");
    assertEquals(result.key("value").get() as unknown, "selected");
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("fetchData state cells use narrowest input scope", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const tx = runtime.edit();

  try {
    const { fetchData, pattern } = createTrustedBuilder(runtime).commonfabric;
    const urlBase = runtime.getCell<string>(
      space,
      "fetchData user scoped url",
      undefined,
      tx,
    );
    const url = createCell<string>(
      runtime,
      { ...urlBase.getAsNormalizedFullLink(), scope: "user" },
      tx,
    );
    url.set("");

    const Root = pattern<{ url: string }>(({ url }) => fetchData({ url }));

    const resultCell = runtime.getCell(
      space,
      "fetchData state cells use narrowest input scope",
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, { url }, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    await runtime.idle();
    await runtime.storageManager.synced();
    await result.pull();

    const pendingLink = parseLink(result.key("pending").getRaw(), result);
    const resultLink = parseLink(result.key("result").getRaw(), result);
    const errorLink = parseLink(result.key("error").getRaw(), result);
    assertEquals(pendingLink?.scope, "user");
    assertEquals(resultLink?.scope, "user");
    assertEquals(errorLink?.scope, "user");
    assertEquals(result.key("pending").get() as unknown, false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
