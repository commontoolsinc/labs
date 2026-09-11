import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { collectViewRenderReads } from "../src/view-render-reads.ts";

const signer = await Identity.fromPassphrase("view renderer reads");
const space = signer.did();

describe("view render reads", () => {
  it("reads visible bindings and children without following fields outside the rendered UI", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    try {
      const draft = runtime.getCell<string>(space, "draft", { type: "string" });
      const hidden = runtime.getCell<string>(space, "hidden", {
        type: "string",
      });
      const label = runtime.getCell<string>(space, "label", { type: "string" });
      const root = runtime.getCell(space, "view", undefined);
      await runtime.editWithRetry((tx) => {
        draft.withTx(tx).set("text");
        hidden.withTx(tx).set("secret");
        label.withTx(tx).set("visible");
        root.withTx(tx).set({
          $UI: {
            type: "vnode",
            name: "cf-input",
            props: { $value: draft, title: label },
            children: [label],
          },
          offscreen: hidden,
        });
      });
      const result = collectViewRenderReads(
        runtime,
        space,
        {
          id: "view",
          revision: 0,
          mode: "speculate",
          componentContractVersion: "1",
          query: {
            roots: [{
              id: root.getAsNormalizedFullLink().id,
              selector: { path: [] },
            }],
          },
        },
        runtime.scopeKeyIdentity,
      );
      expect(result.bindings.map((read) => read.id)).toContain(
        draft.getAsNormalizedFullLink().id,
      );
      const readIds = result.reads.map((read) => read.id);
      expect(readIds).toContain(draft.getAsNormalizedFullLink().id);
      expect(readIds).toContain(label.getAsNormalizedFullLink().id);
      expect(readIds).not.toContain(hidden.getAsNormalizedFullLink().id);
    } finally {
      await runtime.storageManager.synced();
      await runtime.dispose();
    }
  });
});
