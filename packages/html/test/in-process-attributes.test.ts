import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { renderInProcess } from "../src/in-process.ts";
import { MockDoc } from "../src/mock-doc.ts";

describe("in-process-attributes", () => {
  it("reflects successive property values on the same rendered element", async () => {
    const signer = await Identity.fromPassphrase("in-process attributes");
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: StorageManager.emulate({ as: signer }),
    });
    const mock = new MockDoc('<div id="root"></div>');
    const container = mock.document.getElementById("root")!;
    let render: ReturnType<typeof renderInProcess> | undefined;
    try {
      const tx = runtime.edit();
      const vdom = runtime.getCell<unknown>(
        signer.did(),
        "attributes",
        undefined,
        tx,
      );
      vdom.set({
        type: "vnode",
        name: "span",
        props: { "aria-label": "green vote", style: "color: green" },
        children: ["V"],
      });
      await tx.commit();
      render = renderInProcess(container, vdom, {
        document: mock.document,
        setProp: mock.renderOptions.setProp,
      });
      await runtime.idle();
      render.flush();
      const element = container.firstChild;
      expect(element).toBeDefined();
      expect(element).not.toBeNull();
      expect(container.innerHTML).toBe(
        '<span aria-label="green vote" style="color: green">V</span>',
      );

      for (const color of ["yellow", "green"]) {
        const update = runtime.edit();
        vdom.withTx(update).key("props").set({
          "aria-label": `${color} vote`,
          style: `color: ${color}`,
        });
        await update.commit();
        await runtime.idle();
        render.flush();
        expect(container.firstChild).toBe(element);
        expect(container.innerHTML).toBe(
          `<span aria-label="${color} vote" style="color: ${color}">V</span>`,
        );
      }
    } finally {
      render?.cancel();
      await runtime.dispose();
    }
  });
});
