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
    // A guest window receives whatever anyone able to reach it posts. None of
    // these is an update this protocol wrote, and each one used to be a way to
    // make the guest throw rather than pass it by.
    post(undefined);
    post({ type: "not-an-update" });
    post({ type: "update" });
    post({ type: "update", data: ["solo"] });
    post({ type: "update", data: [7, realmFromFabricValue("x")] });
    post({ type: "update", data: ["unencoded", 123] });
    assertDeepEquals(seen, []);

    // The one an update did write arrives, which is what keeps the checks
    // above from passing by refusing everything.
    post({ type: "update", data: ["counted", realmFromFabricValue(9n)] });
    assertEquals(seen.length, 1);
    assertEquals(seen[0][0], "counted");
    assertEquals(seen[0][1], 9n);
  } finally {
    guest.disconnect();
  }
});
