import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cfcLabelViewForCell,
  cfcLabelViewFromMetadata,
} from "../src/cfc/label-view.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

describe("CFC label view helpers", () => {
  it("collects labels that apply to a logical value path", () => {
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: "hash",
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["value", "body"],
            label: { classification: ["prompt-influenced"] },
          },
          {
            path: ["value", "body", "summary"],
            label: { integrity: ["summarized-by-trusted-pattern"] },
          },
          {
            path: ["other"],
            label: { classification: ["not-rendered"] },
          },
        ],
      },
    };

    expect(cfcLabelViewFromMetadata(metadata, ["body"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { classification: ["prompt-influenced"] },
        },
        {
          path: ["summary"],
          label: { integrity: ["summarized-by-trusted-pattern"] },
        },
      ],
    });
  });

  it("does not treat schema constraints as display labels", () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labelled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      get schema() {
        return {
          type: "string",
          ifc: { maxConfidentiality: ["prompt-influence"] },
        };
      },
    };

    expect(cfcLabelViewForCell(cell)).toBeUndefined();
  });

  it("joins labels from the runtime read behind a linked cell", async () => {
    const signer = await Identity.fromPassphrase("cfc label view linked read");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-source",
        undefined,
        tx,
      );
      const sourceLink = parseLink(source.getAsLink());
      tx.writeOrThrow({
        space: signer.did(),
        id: sourceLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: "labelled content",
        cfc: {
          version: 1,
          schemaHash: "test-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { classification: ["prompt-influence"] },
            }],
          },
        },
      });
      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-target",
        undefined,
        tx,
      );
      target.set(source);
      await tx.commit();

      expect(cfcLabelViewForCell(target)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { classification: ["prompt-influence"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reads stored metadata directly from the queried cell", () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labelled-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      runtime: {
        readTx: () => ({
          readOrThrow: () => ({
            cfc: {
              version: 1,
              schemaHash: "test-schema",
              labelMap: {
                version: 1,
                entries: [{
                  path: [],
                  label: { integrity: ["trusted-source"] },
                }],
              },
            },
          }),
        }),
      },
    };

    expect(cfcLabelViewForCell(cell)).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: { integrity: ["trusted-source"] },
      }],
    });
  });
});
