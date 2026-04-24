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
            label: { confidentiality: ["prompt-influenced"] },
          },
          {
            path: ["value", "body", "summary"],
            label: { integrity: ["summarized-by-trusted-pattern"] },
          },
          {
            path: ["other"],
            label: { confidentiality: ["not-rendered"] },
          },
        ],
      },
    };

    expect(cfcLabelViewFromMetadata(metadata, ["body"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { confidentiality: ["prompt-influenced"] },
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
      cfcEnforcementMode: "disabled",
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
              label: { confidentiality: ["prompt-influence"] },
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
          label: { confidentiality: ["prompt-influence"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("distinguishes stored link-field labels from dereferenced cell-view labels", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view stored link field",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-shared-source",
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
        value: { title: "shared", details: "restricted" },
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["shared-space"],
                integrity: ["authored-by-bob"],
              },
            }, {
              path: ["details"],
              label: { confidentiality: ["target-detail"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-personal-link",
        undefined,
        tx,
      );
      const targetLink = parseLink(target.getAsLink());
      tx.writeOrThrow({
        space: signer.did(),
        id: targetLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: source.getAsLink(),
        cfc: {
          version: 1,
          schemaHash: "target-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["personal-space"],
                integrity: ["selected-by-alice"],
              },
            }],
          },
        },
      });
      await tx.commit();

      const storedLinkField = cfcLabelViewFromMetadata(
        {
          version: 1,
          schemaHash: "target-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: ["personal-space"],
                integrity: ["selected-by-alice"],
              },
            }],
          },
        },
        [],
      );
      expect(storedLinkField).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["personal-space"],
            integrity: ["selected-by-alice"],
          },
        }],
      });

      expect(cfcLabelViewForCell(target)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: ["personal-space", "shared-space"],
            integrity: ["selected-by-alice", "authored-by-bob"],
          },
        }, {
          path: ["details"],
          label: { confidentiality: ["target-detail"] },
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

  it("reads source-cell metadata for result-cell internal paths", () => {
    const sourceCell = {
      getAsNormalizedFullLink: () => ({
        id: "of:source-cell",
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
                  path: ["internal", "__#3"],
                  label: {
                    integrity: [{
                      kind: "authored-by",
                      subject: "alice",
                    }],
                  },
                }],
              },
            },
          }),
        }),
      },
    };
    const resultCell = {
      getAsNormalizedFullLink: () => ({
        id: "of:result-cell",
        space: "did:key:test",
        type: "application/json",
        path: ["internal", "__#3"],
      }),
      runtime: {
        readTx: () => ({
          readOrThrow: () => undefined,
        }),
      },
      getSourceCell: () => sourceCell,
    };

    expect(cfcLabelViewForCell(resultCell)).toEqual({
      version: 1,
      entries: [{
        path: [],
        label: {
          integrity: [{
            kind: "authored-by",
            subject: "alice",
          }],
        },
      }],
    });
  });
});
