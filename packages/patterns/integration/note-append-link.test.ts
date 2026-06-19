import { env } from "@commonfabric/integration";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertStringIncludes } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";

const { API_URL } = env;
const SPACE_NAME = "note-append-link-" + Date.now().toString(36);

describe("note appendLink integration", () => {
  let identity: Identity;
  let cc: PiecesController;
  let host: PieceController;
  let target: PieceController;
  const cancels: Array<() => void> = [];

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    const sourcePath = join(import.meta.dirname!, "..", "notes", "note.tsx");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    host = await cc.create(program, {
      input: { title: "Host Note", content: "" },
      start: true,
    });
    target = await cc.create(program, {
      input: { title: "Target Note", content: "" },
      start: true,
    });
    // Keep both pieces reactive (pull mode) so handlers run on send.
    cancels.push(cc.manager().getResult(host.getCell()).sink(() => {}));
    cancels.push(cc.manager().getResult(target.getCell()).sink(() => {}));
  });

  afterAll(async () => {
    for (const c of cancels) c();
    if (cc) await cc.dispose();
  });

  it("appends a [[name (id)]] link carrying the target's real id", async () => {
    // Invoke appendLink (a Stream) by setting its event on the result cell,
    // passing the target piece's cell as the mentionable.
    await host.result.set(
      { piece: target.getCell() },
      ["appendLink"],
    );
    await cc.manager().runtime.idle();
    await cc.manager().synced();

    const content = await host.result.get(["content"]) as string;
    assert(typeof content === "string", "content is not a string");

    // External oracle: the id embedded in the wiki-link must be the target's
    // authoritative id (`target.id` from create) — confirming the pattern's
    // entityRefToString output agrees with the runtime's id seen from *outside*
    // the pattern, not just with itself.
    assertStringIncludes(content, `[[📝 Target Note (${target.id})]]`);
  });
});
