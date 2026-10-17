import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type Cell, hostValueOf } from "../src/cell.ts";
import { componentReadSchema } from "../src/component-read-contract.ts";
import { KeepAsCell } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("runner-component-read-contract");
const space = signer.did();

describe("component-read-contract", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Writes each of `docs` as given, raw, and returns their cells by id. */
  const write = async (
    docs: Record<string, (cells: Record<string, Cell<unknown>>) => unknown>,
  ): Promise<Record<string, Cell<unknown>>> => {
    const cells = Object.fromEntries(
      Object.keys(docs).map((id) => [id, runtime.getCell(space, id)]),
    );
    const tx = runtime.edit();
    for (const [id, valueOf] of Object.entries(docs)) {
      cells[id].withTx(tx).setRawUntyped(valueOf(cells) as never);
    }
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    return cells;
  };

  /** The link a stored document holds to `cell`. */
  const linkTo = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  /** What a host is sent for cf-chart's `marks` bound to `marks`. */
  const chartMarksAsSent = (marks: Cell<unknown>) =>
    hostValueOf(
      marks.asSchema(componentReadSchema("cf-chart", "marks", undefined)!)
        .get(),
    ) as { data: unknown }[];

  describe("componentReadSchema()", () => {
    it("returns a cf-chart `marks` schema under which two marks plotting one series each hold the series", async () => {
      const { marks } = await write({
        series: () => [1, 3, 2],
        marks: ({ series }) => [
          { type: "line", data: linkTo(series) },
          { type: "dot", data: linkTo(series) },
        ],
      });
      const sent = chartMarksAsSent(marks);

      expect(sent[0].data).toEqual([1, 3, 2]);
      expect(sent[1].data).toEqual([1, 3, 2]);
    });

    it("returns a cf-chart `marks` schema under which two points sharing a document each hold it", async () => {
      const { marks } = await write({
        point: () => ({ day: 1, count: 4 }),
        marks: ({ point }) => [
          { type: "dot", data: [linkTo(point), linkTo(point)] },
        ],
      });
      const sent = chartMarksAsSent(marks);

      expect(sent[0].data).toEqual([
        { day: 1, count: 4 },
        { day: 1, count: 4 },
      ]);
    });
  });
});
