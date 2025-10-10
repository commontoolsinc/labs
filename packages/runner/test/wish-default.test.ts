import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type JSONSchema } from "../src/builder/types.ts";
import { isCell } from "../src/cell.ts";
import { isSigilLink, parseLink } from "../src/link-utils.ts";
import { toURI } from "../src/uri-utils.ts";

const signer = await Identity.fromPassphrase("wish test operator");
const space = signer.did();

// Well-known ID used by the Wish resolver MVP
const ALL_CHARMS_ID =
  "baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye";

describe("Wish default handling (MVP)", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ blobbyServerUrl: import.meta.url, storageManager });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("injects a cell for asCell properties with Wish default", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        allCharms: { asCell: true },
      },
      default: { allCharms: { $wish: "allCharms" } },
    };

    const c = runtime.getCell(space, "wish-asCell", schema);
    const v = c.get() as any;
    expect(isCell(v.allCharms)).toBe(true);
    const link = v.allCharms.getAsNormalizedFullLink();
    expect(link.space).toBe(space);
    expect(link.path.length).toBe(0);
    expect(link.id).toBe(toURI(ALL_CHARMS_ID));
  });

  it("injects a sigil link for non-cell properties with Wish default", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        allCharms: {},
      },
      default: { allCharms: { $wish: "allCharms" } },
    };

    const c = runtime.getCell(space, "wish-noncell", schema);
    const v = c.get() as any;
    expect(isSigilLink(v.allCharms)).toBe(true);
    const parsed = parseLink(v.allCharms, c)!
      ;
    expect(parsed.space).toBe(space);
    expect(parsed.path.length).toBe(0);
    expect(parsed.id).toBe(toURI(ALL_CHARMS_ID));
  });
});

