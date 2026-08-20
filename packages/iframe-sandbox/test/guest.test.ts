import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

import { connectGuestContext } from "../src/guest.ts";
import { assertDeepEquals, assertEquals } from "./utils.ts";

// Delivers `data` the way a sender reaching this window would.
function post(data: unknown): void {
  globalThis.dispatchEvent(new MessageEvent("message", { data }));
}

Deno.test("the guest client takes only what an update it can decode carries", () => {
  const seen: [string, FabricValue][] = [];
  const guest = connectGuestContext((key, value) => seen.push([key, value]));

  try {
    // A guest window receives whatever anyone able to reach it posts. The
    // first two are not encodings at all -- the second being the shape this
    // protocol used to put on the wire -- and the rest decode to something an
    // update is not.
    post(undefined);
    post({ type: "update", data: ["plain", 1] });
    post(realmFromFabricValue("not a message at all"));
    post(realmFromFabricValue({ type: "not-an-update" }));
    post(realmFromFabricValue({ type: "update" }));
    post(realmFromFabricValue({ type: "update", data: ["solo"] }));
    post(realmFromFabricValue({ type: "update", data: [7, "non-string key"] }));
    assertDeepEquals(seen, []);

    // The one an update did write arrives, which is what keeps the checks
    // above from passing by refusing everything.
    post(realmFromFabricValue({ type: "update", data: ["counted", 9n] }));
    assertEquals(seen.length, 1);
    assertEquals(seen[0][0], "counted");
    assertEquals(seen[0][1], 9n);
  } finally {
    guest.disconnect();
  }
});
