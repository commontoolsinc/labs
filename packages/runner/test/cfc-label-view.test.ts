import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  cfcLabelViewForCell,
  cfcLabelViewFromMetadata,
} from "../src/cfc/label-view.ts";
import {
  redactSigilCfcLabelViewsForDisplay,
  stripSigilCfcLabelViews,
} from "../src/cfc/link-label-view.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { toCell } from "../src/back-to-cell.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { type FactoryInput, UI } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";

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

  it("rebases wildcard label paths onto concrete array item paths", () => {
    const metadata: CfcMetadata = {
      version: 1,
      schemaHash: "hash",
      labelMap: {
        version: 1,
        entries: [
          {
            path: ["value", "*"],
            label: { integrity: ["trusted-item"] },
          },
          {
            path: ["value", "*", "title"],
            label: { integrity: ["trusted-title"] },
          },
        ],
      },
    };

    expect(cfcLabelViewFromMetadata(metadata, ["0"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: { integrity: ["trusted-item"] },
        },
        {
          path: ["title"],
          label: { integrity: ["trusted-title"] },
        },
      ],
    });
    expect(cfcLabelViewFromMetadata(metadata, ["0", "title"])).toEqual({
      version: 1,
      entries: [
        {
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "trusted-item",
              "trusted-title",
            ]),
          },
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

  it("does not ask result metadata for label display", () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:labelled-result-cell",
        space: "did:key:test",
        type: "application/json",
        path: [],
      }),
      getMetaRaw: () => {
        throw new Error("result metadata should not be consulted");
      },
    };

    expect(cfcLabelViewForCell(cell)).toBeUndefined();
  });

  it("does not synthesize runtime reads for linked cells", async () => {
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

      expect(cfcLabelViewForCell(target)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rebases nested linked value labels to the linked target path", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view nested linked target path",
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
        "cfc-label-view-nested-source",
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
        "cfc-label-view-nested-link",
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
        value: {
          detail: source.key("details").getAsLink(),
        },
        cfc: {
          version: 1,
          schemaHash: "target-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["detail"],
              label: { integrity: ["selected-detail"] },
            }],
          },
        },
      });
      await tx.commit();

      expect(cfcLabelViewForCell(target.key("detail"))).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "shared-space",
              "target-detail",
            ]),
            integrity: expect.arrayContaining([
              "authored-by-bob",
              "selected-detail",
            ]),
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("preserves ref-carried label views when creating cells from sigil links", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view sigil carried state",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const view = {
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["carried-through-sigil"] },
        }],
      } as const;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-label-view-carried-sigil",
      );
      const link = cell.getAsLink() as any;
      link["/"][LINK_V1_TAG].cfcLabelView = view;

      const recovered = runtime.getCellFromLink(link);
      expect(cfcLabelViewForCell(recovered)).toEqual(view);
      expect(linkRefPayload(recovered.getAsLink())).not.toHaveProperty(
        "cfcLabelView",
      );
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
            confidentiality: ["personal-space"],
            integrity: ["selected-by-alice"],
          },
        }],
      });

      const resolvedTarget = target.resolveAsCell();
      expect(cfcLabelViewForCell(resolvedTarget)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "personal-space",
              "shared-space",
            ]),
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
        }, {
          path: ["details"],
          label: { confidentiality: ["target-detail"] },
        }],
      });

      expect(cfcLabelViewForCell(resolvedTarget.asSchema({
        type: "object",
        properties: { details: { type: "string" } },
      }))).toEqual(cfcLabelViewForCell(resolvedTarget));
      const siblingTx = runtime.edit();
      expect(cfcLabelViewForCell(resolvedTarget.withTx(siblingTx)))
        .toEqual(cfcLabelViewForCell(resolvedTarget));
      siblingTx.abort();

      expect(cfcLabelViewForCell(resolvedTarget.key("details"))).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            confidentiality: expect.arrayContaining([
              "personal-space",
              "shared-space",
              "target-detail",
            ]),
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps accumulated link labels on cells recovered from query results", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view query result to cell",
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
        "cfc-label-view-query-source",
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
        value: { title: "shared" },
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-by-bob"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-query-target",
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
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      });
      await tx.commit();

      const value = target.get();
      const recovered = (value as { [toCell]: () => unknown })[toCell]();
      expect(cfcLabelViewForCell(recovered)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps accumulated link labels on schema asCell materialization", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view schema asCell",
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
        "cfc-label-view-as-cell-source",
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
        value: { title: "as cell" },
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-by-bob"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-as-cell-target",
        {
          asCell: ["cell"],
          type: "object",
          properties: { title: { type: "string" } },
        },
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
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      });
      await tx.commit();

      const recovered = target.get();
      expect(cfcLabelViewForCell(recovered)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not leak sibling labels on cross-document schema asCell children", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view cross doc sibling labels",
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
        "cfc-label-view-sibling-source",
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
        value: { a: "first", b: "second" },
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["a"],
              label: { integrity: ["source-a"] },
            }, {
              path: ["b"],
              label: { integrity: ["source-b"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-sibling-target",
        {
          type: "object",
          properties: {
            a: { type: "string", asCell: ["cell"] },
            b: { type: "string", asCell: ["cell"] },
          },
        },
        tx,
      );
      target.set(source);
      await tx.commit();

      const recovered = target.get() as { a: unknown; b: unknown };
      expect(cfcLabelViewForCell(recovered.a)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["source-a"] },
        }],
      });
      expect(cfcLabelViewForCell(recovered.b)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["source-b"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps accumulated link labels on default-created asCell values", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view default asCell",
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
        "cfc-label-view-default-source",
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
        value: {},
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-by-bob"] },
            }],
          },
        },
      });

      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-default-target",
        {
          type: "object",
          properties: {
            item: {
              asCell: ["cell"],
              type: "object",
              default: { title: "fallback" },
              properties: { title: { type: "string" } },
            },
          },
        },
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
              label: { integrity: ["selected-by-alice"] },
            }],
          },
        },
      });
      await tx.commit();

      const recovered = target.get() as { item: unknown };
      expect(cfcLabelViewForCell(recovered.item)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-by-alice",
              "authored-by-bob",
            ]),
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps per-element labels through native array map proxies", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view array map proxies",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const first = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-first",
        undefined,
        tx,
      );
      const second = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-second",
        undefined,
        tx,
      );
      const firstLink = parseLink(first.getAsLink());
      const secondLink = parseLink(second.getAsLink());
      for (
        const [link, value, integrity] of [
          [firstLink, { title: "first" }, "authored-first"],
          [secondLink, { title: "second" }, "authored-second"],
        ] as const
      ) {
        tx.writeOrThrow({
          space: signer.did(),
          id: link.id!,
          type: "application/json",
          path: [],
        }, {
          value,
          cfc: {
            version: 1,
            schemaHash: "item-schema",
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { integrity: [integrity] },
              }],
            },
          },
        });
      }

      const list = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-list",
        undefined,
        tx,
      );
      const listLink = parseLink(list.getAsLink());
      tx.writeOrThrow({
        space: signer.did(),
        id: listLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: [first.getAsLink(), second.getAsLink()],
        cfc: {
          version: 1,
          schemaHash: "list-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["0"],
              label: { integrity: ["selected-first"] },
            }, {
              path: ["1"],
              label: { integrity: ["selected-second"] },
            }],
          },
        },
      });
      await tx.commit();

      const recovered = (list.get() as unknown[]).map((item) =>
        (item as { [toCell]: () => unknown })[toCell]()
      );
      expect(cfcLabelViewForCell(recovered[0])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-first",
              "authored-first",
            ]),
          },
        }],
      });
      expect(cfcLabelViewForCell(recovered[1])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-second",
              "authored-second",
            ]),
          },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not reuse query proxies across different carried label views", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view query proxy cache",
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
        "cfc-label-view-cache-source",
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
        value: { title: "shared" },
        cfc: {
          version: 1,
          schemaHash: "source-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { integrity: ["authored-shared"] },
            }],
          },
        },
      });

      const list = runtime.getCell(
        signer.did(),
        "cfc-label-view-cache-list",
        undefined,
        tx,
      );
      const listLink = parseLink(list.getAsLink());
      tx.writeOrThrow({
        space: signer.did(),
        id: listLink.id!,
        type: "application/json",
        path: [],
      }, {
        value: [source.getAsLink(), source.getAsLink()],
        cfc: {
          version: 1,
          schemaHash: "list-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["0"],
              label: { integrity: ["selected-first"] },
            }, {
              path: ["1"],
              label: { integrity: ["selected-second"] },
            }],
          },
        },
      });
      await tx.commit();

      const recovered = (list.get() as unknown[]).map((item) =>
        (item as { [toCell]: () => unknown })[toCell]()
      );
      expect(cfcLabelViewForCell(recovered[0])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-first",
              "authored-shared",
            ]),
          },
        }],
      });
      expect(cfcLabelViewForCell(recovered[1])).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: expect.arrayContaining([
              "selected-second",
              "authored-shared",
            ]),
          },
        }],
      });
      expect(
        cfcLabelViewForCell(recovered[1])?.entries[0].label.integrity,
      ).not.toContain("selected-first");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("recovers per-item integrity from mapped VDOM output cells", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view pattern map vdom",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const first = runtime.getCell(
        signer.did(),
        "cfc-label-view-pattern-first",
        undefined,
        tx,
      );
      const second = runtime.getCell(
        signer.did(),
        "cfc-label-view-pattern-second",
        undefined,
        tx,
      );
      for (
        const [cell, value, integrity] of [
          [first, { title: "First" }, "item-integrity-first"],
          [second, { title: "Second" }, "item-integrity-second"],
        ] as const
      ) {
        const link = parseLink(cell.getAsLink());
        tx.writeOrThrow({
          space: signer.did(),
          id: link.id!,
          type: "application/json",
          path: [],
        }, {
          value,
          cfc: {
            version: 1,
            schemaHash: "item-schema",
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { integrity: [integrity] },
              }],
            },
          },
        });
      }

      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern } = commonfabric;
      const renderLabels = pattern<{ items: unknown[] }>(({ items }) => {
        const rendered = (items as any).mapWithPattern(
          pattern(({ element, index, array }: FactoryInput<any>) =>
            (((item: any) => ({
              [UI]: {
                type: "vnode" as const,
                name: "cf-cfc-label",
                props: { value: item },
                children: [],
              },
            })) as any)(element, index, array)
          ),
          {},
        );
        return { rendered };
      });

      const resultCell = runtime.getCell(
        signer.did(),
        "cfc-label-view-pattern-result",
        undefined,
        tx,
      );
      const result = runtime.run(
        tx,
        renderLabels,
        { items: [first, second] },
        resultCell,
      );
      await tx.commit();
      await result.pull();

      const firstValue = result
        .key("rendered")
        .key("0")
        .key(UI)
        .key("props")
        .key("value")
        .resolveAsCell();
      const secondValue = result
        .key("rendered")
        .key("1")
        .key(UI)
        .key("props")
        .key("value")
        .resolveAsCell();

      expect(cfcLabelViewForCell(firstValue)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["item-integrity-first"] },
        }],
      });
      expect(cfcLabelViewForCell(secondValue)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["item-integrity-second"] },
        }],
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("follows array-element links to stored metadata", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view linked array entry",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-source",
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
        value: { body: "labelled content" },
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
      });
      const target = runtime.getCell(
        signer.did(),
        "cfc-label-view-array-target",
        { type: "array", items: true },
        tx,
      );
      target.setRawUntyped([source.getAsLink()]);
      await tx.commit();

      const schemaLessEntry = runtime.getCellFromLink({
        ...target.key(0).getAsNormalizedFullLink(),
        schema: undefined,
      });

      expect(cfcLabelViewForCell(schemaLessEntry)).toEqual({
        version: 1,
        entries: [{
          path: [],
          label: { integrity: ["trusted-source"] },
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

  it("skips result metadata for result-cell internal paths", () => {
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
      getMetaRaw: () => {
        throw new Error("result metadata should not be consulted");
      },
    };

    expect(cfcLabelViewForCell(resultCell)).toBeUndefined();
  });

  it("re-fires an includeCfcLabel sink on a label-only write (value unchanged)", async () => {
    const signer = await Identity.fromPassphrase(
      "cfc label view sink reactivity",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const cell = runtime.getCell<{ body: string }>(
        signer.did(),
        "cfc-label-sink-reactivity",
      );
      const id = parseLink(cell.getAsLink()).id!;
      const writeDoc = (integrityAtom: string) => {
        const tx = runtime.edit();
        tx.writeOrThrow({
          space: signer.did(),
          id,
          type: "application/json",
          path: [],
        }, {
          // SAME value both times — only the label changes.
          value: { body: "unchanging" },
          cfc: {
            version: 1,
            schemaHash: "sink-reactivity",
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { integrity: [integrityAtom] } }],
            },
          },
        });
        return tx.commit();
      };

      await writeDoc("authored-by-alice");
      await runtime.idle();

      const fires: Array<
        { value: { body: string } | undefined; label: unknown }
      > = [];
      const cancel = cell.sink((value, cfcLabel) => {
        fires.push({ value, label: cfcLabel });
      }, { includeCfcLabel: true });

      // The label-only write: value identical, integrity atom changed.
      await writeDoc("authored-by-bob");
      await runtime.idle();
      cancel();

      // Fired on subscribe AND again on the label-only write.
      expect(fires.length).toBeGreaterThanOrEqual(2);
      // The value never changed across fires — this was purely a label change.
      for (const fire of fires) {
        expect(fire.value).toEqual({ body: "unchanging" });
      }
      // The first delivered label carried alice, the last carries bob.
      expect(JSON.stringify(fires[0].label)).toContain("authored-by-alice");
      expect(JSON.stringify(fires.at(-1)!.label)).toContain("authored-by-bob");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});

// Inv-12 Stage 0: the display redaction that already covers the top-level
// cfcLabel at the IPC response sites, extended to the cfcLabelView copies
// riding sigil links inside response values.
describe("redactSigilCfcLabelViewsForDisplay", () => {
  const caveat = {
    type: "https://commonfabric.org/cfc/atom/Caveat",
    kind: "derived-from",
    source: "did:key:alice",
  };
  const linkWithView = (id: string) => ({
    "/": {
      [LINK_V1_TAG]: {
        id,
        space: "did:key:test",
        path: [],
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: { confidentiality: [caveat] },
          }],
        },
      },
    },
  });

  it("redacts Caveat.source on views nested anywhere in the value", () => {
    const value = {
      items: [linkWithView("of:a"), { deep: linkWithView("of:b") }],
      plain: "text",
    };
    const redacted = redactSigilCfcLabelViewsForDisplay(value) as typeof value;
    for (
      const payload of [
        redacted.items[0] as ReturnType<typeof linkWithView>,
        (redacted.items[1] as { deep: ReturnType<typeof linkWithView> }).deep,
      ]
    ) {
      const atom = payload["/"][LINK_V1_TAG].cfcLabelView
        .entries[0].label.confidentiality[0] as Record<string, unknown>;
      expect(atom.type).toBe(caveat.type);
      expect(atom.kind).toBe("derived-from");
      expect("source" in atom).toBe(false);
    }
    // Non-view content is untouched.
    expect(redacted.plain).toBe("text");
    // The input is not mutated (frozen response values).
    const original = (value.items[0] as ReturnType<typeof linkWithView>)["/"][
      LINK_V1_TAG
    ].cfcLabelView.entries[0].label.confidentiality[0] as Record<
      string,
      unknown
    >;
    expect(original.source).toBe("did:key:alice");
  });

  it("returns unchanged subtrees by reference (copy-on-write)", () => {
    const viewless = {
      nested: { list: [1, 2, 3] },
      link: {
        "/": { [LINK_V1_TAG]: { id: "of:c", space: "did:key:test", path: [] } },
      },
    };
    expect(redactSigilCfcLabelViewsForDisplay(viewless)).toBe(viewless);

    const mixed = { untouched: viewless.nested, tagged: linkWithView("of:d") };
    const redacted = redactSigilCfcLabelViewsForDisplay(mixed) as typeof mixed;
    expect(redacted).not.toBe(mixed);
    expect(redacted.untouched).toBe(viewless.nested);
    expect(redacted.tagged).not.toBe(mixed.tagged);
  });

  // The inbound sibling: rather than redacting the view, ingress strips it
  // entirely (main-thread views must not become worker label state).
  it("stripSigilCfcLabelViews removes views and keeps addressing intact", () => {
    const value = {
      items: [linkWithView("of:strip-a")],
      plain: 7,
    };
    const stripped = stripSigilCfcLabelViews(value) as {
      items: Array<{ "/": Record<string, Record<string, unknown>> }>;
      plain: number;
    };
    const payload = stripped.items[0]["/"][LINK_V1_TAG];
    expect(payload.id).toBe("of:strip-a");
    expect("cfcLabelView" in payload).toBe(false);
    expect(stripped.plain).toBe(7);
    // Copy-on-write here too: a viewless tree passes through by reference,
    // and the input is not mutated.
    const viewless = { link: { "/": { [LINK_V1_TAG]: { id: "of:e" } } } };
    expect(stripSigilCfcLabelViews(viewless)).toBe(viewless);
    expect(
      (value.items[0] as ReturnType<typeof linkWithView>)["/"][LINK_V1_TAG]
        .cfcLabelView,
    ).toBeDefined();
  });
});
