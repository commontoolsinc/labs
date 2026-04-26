import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type JSONSchema, NAME } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("wish shared hashtag test");
const space = signer.did();

function schemaForMentionable(index: number): JSONSchema {
  return {
    type: "object",
    title: `Shared hashtag test note ${index}`,
    description:
      "This schema intentionally has #something-else, not the queried tag.",
    properties: {
      [NAME]: { type: "string" },
      body: { type: "string" },
    },
  };
}

function wishSearchCount(): number {
  const counts = getLoggerCountsBreakdown();
  return counts["runner.wish-flow"]?.["wish/search-hashtag/#notebook"]
    ?.total ?? 0;
}

Deno.test(
  "shared hashtag wish node scans mentionables once for repeated identical wishes",
  async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.enablePullMode();

    try {
      const tx = runtime.edit();
      const spaceCell = runtime.getCell(space, space, undefined, tx).withTx(tx);
      const defaultPatternCell = runtime.getCell(
        space,
        "shared-hashtag-default-pattern",
        undefined,
        tx,
      );
      const backlinksIndexCell = runtime.getCell(
        space,
        "shared-hashtag-backlinks-index",
        undefined,
        tx,
      );
      const mentionables = Array.from({ length: 30 }, (_, index) => {
        const cell = runtime.getCell(
          space,
          `shared-hashtag-mentionable-${index}`,
          schemaForMentionable(index),
          tx,
        );
        cell.set({
          [NAME]: `note-${index}`,
          body: `body-${index}`,
        });
        return cell;
      });

      backlinksIndexCell.set({ mentionable: mentionables });
      defaultPatternCell.set({ backlinksIndex: backlinksIndexCell });
      spaceCell.key("defaultPattern").set(defaultPatternCell);

      const { commonfabric } = createTrustedBuilder(runtime);
      const wishPattern = commonfabric.pattern(() => {
        return {
          result: commonfabric.wish({
            query: "#notebook",
            scope: ["."],
            headless: true,
          }),
        };
      });

      const results = Array.from({ length: 30 }, (_, index) => {
        const resultCell = runtime.getCell(
          space,
          `shared-hashtag-result-${index}`,
          undefined,
          tx,
        );
        return runtime.run(tx, wishPattern, {}, resultCell);
      });

      await tx.commit();
      const before = wishSearchCount();

      const values = await Promise.all(results.map((result) => result.pull()));

      expect(wishSearchCount() - before).toBe(1);
      for (const value of values) {
        const wishResult = (value as { result?: { error?: string } }).result;
        expect(wishResult?.error).toContain("No mentionables found matching");
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);
