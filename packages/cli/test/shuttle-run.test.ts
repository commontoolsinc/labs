/**
 * Unit tests for running a shuttle: the connection, the place, and the prompt
 * composed into one session.
 *
 * Both ends are stood in for — the connection by an opener the case supplies,
 * and the terminal by one that delivers a scripted line — so what is under
 * test is the composing. A case that wants to know where the place stands asks
 * the session for it, by typing `pwd` at the prompt and reading what came
 * back, which is the only way in that does not reach past the seam.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";

import type { SpaceConfig } from "../lib/piece.ts";
import type { PromptTerminal } from "../lib/shuttle/prompt.ts";
import { runShuttle, type ShuttleDeps } from "../lib/shuttle/run.ts";
import type { Key } from "../lib/view/keys.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example",
  space: "board",
  identity: "/keys/shuttle.pkcs8",
};

/** What a case saw of the session it ran. */
interface Ran {
  /** The config each opener call was given. */
  readonly opened: SpaceConfig[];

  /** How many times the connection was closed. */
  closed(): number;

  /** What each line the case typed produced. */
  readonly produced: string[];
}

/** Helper for the cases below, which is `text` typed one key at a time. */
function typed(text: string): Key[] {
  return [...text].map((char) => ({ name: char, char }));
}

/**
 * Helper for the cases below, which runs a session that types `line` and
 * returns what it saw.
 *
 * `deps` overrides what the helper supplies, which is what lets a case hand
 * in an opener that fails or a terminal that throws.
 */
async function running(
  line: string,
  deps: ShuttleDeps = {},
): Promise<Ran> {
  const opened: SpaceConfig[] = [];
  const produced: string[] = [];
  let closed = 0;
  const pieces = {
    dispose: () => {
      closed += 1;
      return Promise.resolve();
    },
    getSpace: () => SPACE,
    getSpaceName: () => "board",
  } as unknown as PiecesController;
  const terminal: PromptTerminal = {
    keys: ReadableStream.from([...typed(line), { name: "enter" }]),
    edit: () => {},
    finish: (text) => {
      produced.push(text);
    },
  };
  await runShuttle(CONFIG, {
    open: (config) => {
      opened.push(config);
      return Promise.resolve(pieces);
    },
    terminal: (body) => body(terminal),
    ...deps,
  });
  return { opened, closed: () => closed, produced };
}

describe("runShuttle()", () => {
  it("opens one connection, over the config it was given", async () => {
    const ran = await running("");
    expect(ran.opened).toEqual([CONFIG]);
  });

  it("stands the place in the space the connection settled on", async () => {
    // The config names the space `board`; what a place holds is the DID the
    // session resolved that name to, which is why the connection has to be
    // open before the place exists.

    const ran = await running("pwd");
    expect(ran.produced[0]).toBe(
      `position  @${SPACE}/\nscope     @space`,
    );
  });

  it("closes the connection it opened", async () => {
    const ran = await running("");
    expect(ran.closed()).toBe(1);
  });

  it("closes the connection where the session threw", async () => {
    let closed = 0;
    const pieces = {
      dispose: () => {
        closed += 1;
        return Promise.resolve();
      },
      getSpace: () => SPACE,
      getSpaceName: () => "board",
    } as unknown as PiecesController;
    await expect(runShuttle(CONFIG, {
      open: () => Promise.resolve(pieces),
      terminal: () => Promise.reject(new Error("No terminal.")),
    })).rejects.toThrow("No terminal.");
    expect(closed).toBe(1);
  });

  it("reports the connection that would not open, and reaches no terminal", async () => {
    // What the name does not claim is that nothing was closed. With no
    // connection there is no controller to close, so a case asserting a
    // close count would be asserting on a stub nothing could reach. What is
    // observable is that the opener's own failure is what comes back — a
    // disposal that raised over it would say something else — and that the
    // run stops before the terminal.

    let reached = false;
    await expect(runShuttle(CONFIG, {
      open: () => Promise.reject(new Error("The server refused.")),
      terminal: (body) => {
        reached = true;
        return body({
          keys: ReadableStream.from([]),
          edit: () => {},
          finish: () => {},
        });
      },
    })).rejects.toThrow("The server refused.");
    expect(reached).toBe(false);
  });
});
