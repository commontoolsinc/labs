/**
 * Unit tests for the prompt: the loop that reads a line and writes what it
 * produced.
 *
 * Every case drives the whole loop with a scripted key stream and reads back
 * the writes it made, so what is under test is the loop and the bindings — the
 * terminal, the keyboard and the escape sequences are all somewhere else.
 *
 * The connection is a borrowed one throughout and no case reaches it: a verb
 * that reads stands its read in through the deps bag, so what the prompt does
 * with what a read returned is what these cases turn on.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { PiecesController } from "@commonfabric/piece/ops";

import type { SpaceConfig } from "../lib/piece.ts";
import { safeStringify } from "../lib/render.ts";
import { HeldConnection } from "../lib/shuttle/connection.ts";
import { CurrentPlace } from "../lib/shuttle/place.ts";
import { type PromptTerminal, runPrompt } from "../lib/shuttle/prompt.ts";
import type { Shuttle, VerbDeps } from "../lib/shuttle/verbs.ts";
import type { Key } from "../lib/view/keys.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

const CONFIG: SpaceConfig = {
  apiUrl: "https://toolshed.example/",
  space: SPACE,
  identity: "/keys/shuttle.pkcs8",
};

/** The prompt a shuttle standing at the space root carries. */
const AT_ROOT = "shuttle / @space> ";

/** What the prompt wrote, in the order it wrote it. */
type Write =
  /** It drew `text` as the line being edited, the cursor `column` into it. */
  | { readonly kind: "edit"; readonly text: string; readonly column: number }
  /** It ended that line and wrote `text` under it. */
  | { readonly kind: "finish"; readonly text: string };

/** Helper for the cases below, which is a shuttle at the space root. */
function shuttleIn(): Shuttle {
  return {
    config: CONFIG,
    place: new CurrentPlace(SPACE),
    connection: new HeldConnection({
      kind: "borrowed",
      pieces: {
        dispose: () => Promise.resolve(),
        getSpace: () => SPACE,
        getSpaceName: () => "board",
      } as unknown as PiecesController,
    }),
  };
}

/** Helper for the cases below, which stands a shuttle at a piece. */
function atPiece(): Shuttle {
  const shuttle = shuttleIn();
  shuttle.place.cd(`/${HANDLE}`);
  return shuttle;
}

/** Helper for the cases below, which is `text` typed one key at a time. */
function typed(text: string): Key[] {
  return [...text].map((char) => ({ name: char, char }));
}

/** Helper for the cases below, which is the key that runs a line. */
const ENTER: Key = { name: "enter" };

/** Helper for the cases below, which is `letter` typed with control held. */
function control(letter: string): Key {
  return { name: `ctrl-${letter}`, ctrl: true };
}

/** Helper for the cases below, which is `letter` typed with alt held. */
function alt(letter: string): Key {
  return { name: letter, alt: true };
}

/**
 * Helper for the cases below, which runs `keys` against `shuttle` and returns
 * what the prompt wrote.
 *
 * The keys are a stream that ends, which is the only thing that ends a run
 * that no key ended: a case says what it types and the loop returns.
 */
async function running(
  keys: readonly Key[],
  shuttle: Shuttle = shuttleIn(),
  deps: VerbDeps = {},
): Promise<Write[]> {
  const writes: Write[] = [];
  const terminal: PromptTerminal = {
    keys: ReadableStream.from(keys),
    edit: (text, column) => {
      writes.push({ kind: "edit", text, column });
    },
    finish: (text) => {
      writes.push({ kind: "finish", text });
    },
  };
  await runPrompt(shuttle, terminal, deps);
  return writes;
}

/** Helper for the cases below, which is the last line the prompt drew. */
function drawn(writes: readonly Write[]): Write | undefined {
  return writes.filter((write) => write.kind === "edit").at(-1);
}

/** Helper for the cases below, which is what each line produced, in order. */
function produced(writes: readonly Write[]): string[] {
  return writes.filter((write) => write.kind === "finish")
    .map((write) => write.text);
}

describe("prompt", () => {
  describe("runPrompt()", () => {
    it("draws the prompt before a key is typed", async () => {
      expect(await running([])).toEqual([
        { kind: "edit", text: AT_ROOT, column: AT_ROOT.length },
        { kind: "finish", text: "" },
      ]);
    });

    it("draws the line as it is typed, and writes what it produced under it", async () => {
      // The one case reading the whole log. What it pins is the order: the
      // line is drawn where it was typed and its result lands under it, which
      // is what makes a transcript a record of what happened.

      expect(await running([...typed("pw"), ENTER])).toEqual([
        { kind: "edit", text: AT_ROOT, column: 18 },
        { kind: "edit", text: `${AT_ROOT}p`, column: 19 },
        { kind: "edit", text: `${AT_ROOT}pw`, column: 20 },
        {
          kind: "finish",
          text: "`pw` is not a verb. The verbs are `cd`, `get`, `ls`, `pwd`, " +
            "`where`, and `wish`.",
        },
        { kind: "edit", text: AT_ROOT, column: 18 },
        { kind: "finish", text: "" },
      ]);
    });

    it("writes the text a verb composed", async () => {
      expect(produced(await running([...typed("pwd"), ENTER]))).toEqual([
        `position  @${SPACE}/\nscope     @space`,
        "",
      ]);
    });

    it("writes nothing under a line naming no verb at all", async () => {
      expect(produced(await running([ENTER]))).toEqual(["", ""]);
    });

    it("writes nothing under a line that moved the place", async () => {
      expect(produced(await running([...typed("cd slugs"), ENTER])))
        .toEqual(["", ""]);
    });

    it("draws the place a line moved to at the next prompt", async () => {
      const writes = await running([...typed("cd slugs"), ENTER]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: "shuttle /slugs/ @space> ",
        column: 24,
      });
    });

    it("writes a value as indented JSON", async () => {
      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve({ title: "a" }),
      });
      expect(produced(writes)).toEqual(['{\n  "title": "a"\n}', ""]);
    });

    it("writes `undefined` for a value nothing else can be written for", async () => {
      // `JSON.stringify` returns no string at all for it, so a value the
      // fabric does not hold would otherwise print as nothing and read as a
      // line that produced none.

      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve(undefined),
      });
      expect(produced(writes)).toEqual(["undefined", ""]);
    });

    it("writes a value's acted-on characters as the escapes JSON spells them with", async () => {
      // `JSON.stringify` finishes C0 and leaves `DEL` and every C1 character
      // as it found them, so those are what is left to escape. The convention
      // is JSON's own rather than the glyphs a message gets, because this is a
      // value somebody may parse or paste rather than prose they read.

      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () =>
          Promise.resolve({ title: "a\u007fb\u009bc\u001bd" }),
      });
      expect(produced(writes)[0]).toBe(
        '{\n  "title": "a\\u007fb\\u009bc\\u001bd"\n}',
      );
    });

    it("writes a value holding no acted-on character unchanged", async () => {
      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve({ title: "a b" }),
      });
      expect(produced(writes)[0]).toBe('{\n  "title": "a b"\n}');
    });

    it("leaves the line breaks the writer laid the value out with", async () => {
      // A line feed still standing raw in that output is the pretty printer's
      // own formatting, because every C0 character a value held is escaped
      // before this sees it. Escaping it would fold the value onto one line.

      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve({ a: 1, b: 2 }),
      });
      expect(produced(writes)[0]).toBe('{\n  "a": 1,\n  "b": 2\n}');
    });

    it("writes a line break inside a value as the escape, not as a break", () => {
      // The other side of the same boundary: a break the value holds is two
      // characters by the time this reads it, so the row it is written on is
      // still one row.

      expect(JSON.stringify({ a: "x\ny" }, null, 2)).toBe(
        '{\n  "a": "x\\ny"\n}',
      );
    });

    it("writes a value that still parses back to the value it was", async () => {
      // What the convention buys: the output is JSON, and reading it back
      // gives what the fabric held rather than what the escaping did to it.

      const held = { title: "a\u007fb\u009bc", nested: [1, "d\u0000e"] };
      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve(held),
      });
      const printed = produced(writes)[0];
      expect(/\p{Cc}/u.test(printed.replaceAll("\n", ""))).toBe(false);
      expect(JSON.parse(printed)).toEqual(held);
    });

    it("names the kind of a value JSON has no form for, rather than the word", async () => {
      // `JSON.stringify` returns no string for a symbol and for a function
      // exactly as it does for `undefined`, and without throwing, so a reader
      // told `undefined` would be told the cell was empty when it is not —
      // and the loop would hand a non-string to the terminal, which ends the
      // session on the first one of these.
      //
      // The symbol is registry-interned because that is the kind a cell
      // takes: the fabric's admission test refuses a unique one
      // (`assertValidFabricValueLayer`). The function is the other side of
      // that same test, refused on the way in and so unreachable from a read
      // — it is here because the parameter is `unknown` and what a wrong
      // answer costs is the session.

      for (
        const [value, kind] of [
          [Symbol.for("cf.shuttle.written"), "symbol"],
          [() => {}, "function"],
        ] as const
      ) {
        const writes = await running([...typed("get"), ENTER], atPiece(), {
          getCellValue: () => Promise.resolve(value),
        });
        expect(produced(writes)[0])
          .toBe(`The value is a ${kind}, which JSON has no way to write.`);
      }
    });

    it("drops a nested value JSON has no form for, and says nothing", async () => {
      // The bound the doc comment on `written` names, pinned so that it is a
      // measured property rather than a claim. A cell takes each of these and
      // hands it back: the fabric's admission test accepts `undefined`, an
      // array's hole, and a registry-interned symbol. What JSON does to them
      // differs by position, and the array is the worse half — a key that
      // vanishes reads as a key the fabric does not hold, but an element
      // rewritten to `null` reads as a value the fabric holds.

      const holed: (number | undefined)[] = [1, 2, 3];
      delete holed[1];

      for (
        const [held, printed] of [
          [{ a: 1, b: undefined }, '{\n  "a": 1\n}'],
          [{ a: 1, b: Symbol.for("cf.shuttle.nested") }, '{\n  "a": 1\n}'],
          [[1, undefined, 3], "[\n  1,\n  null,\n  3\n]"],
          [holed, "[\n  1,\n  null,\n  3\n]"],
        ] as const
      ) {
        const writes = await running([...typed("get"), ENTER], atPiece(), {
          getCellValue: () => Promise.resolve(held),
        });
        expect(produced(writes)[0]).toBe(printed);
      }
    });

    it("writes a `bigint` the way `cf cell get` writes one", async () => {
      // A `bigint` is a value a cell holds — it survives a cold replica in
      // the runner's `action-result-fabric-values.test.ts` — and the writer
      // throws on one rather than declining it, so with no arm for it the
      // prompt answers a legitimate read with the engine's own message.
      //
      // The form belongs to `cf cell get`, so this asks that printer for it
      // instead of restating its spelling: a change to either side reds here
      // rather than letting one question acquire two answers. The literal
      // below is what stops both sides drifting together.

      for (const held of [{ a: 1, b: 2n }, 9007199254740993n]) {
        const writes = await running([...typed("get"), ENTER], atPiece(), {
          getCellValue: () => Promise.resolve(held),
        });
        expect(produced(writes)[0]).toBe(safeStringify(held));
      }

      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve({ a: 1, b: 2n }),
      });
      expect(produced(writes)[0]).toBe(
        '{\n  "a": 1,\n  "b": {\n    "$bigint": "2"\n  }\n}',
      );
    });

    it("writes the writer's own failure for a value it cannot walk at all", async () => {
      // A cycle is not something the writer can take, and a shell that ended
      // on one would end on a value the fabric holds perfectly well.

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => Promise.resolve(cyclic),
      });
      expect(produced(writes)[0]).toContain("circular");
    });

    it("writes the message of a read that failed, and reads the next line", async () => {
      const writes = await running(
        [...typed("get"), ENTER, ...typed("pwd"), ENTER],
        atPiece(),
        {
          getCellValue: () => {
            throw new Error("The server cannot be reached.");
          },
        },
      );
      expect(produced(writes)).toEqual([
        "The server cannot be reached.",
        `position  /@${SPACE}/${HANDLE}@space\nscope     @space`,
        "",
      ]);
    });

    it("ends the run on `ctrl-d` at an empty line", async () => {
      expect(produced(await running([control("d"), ...typed("pwd"), ENTER])))
        .toEqual([""]);
    });

    it("deletes forward on `ctrl-d` with something on the line", async () => {
      const writes = await running([
        ...typed("ab"),
        control("a"),
        control("d"),
      ]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}b`,
        column: 18,
      });
    });

    it("abandons the line on `ctrl-c` and reads the next one", async () => {
      expect(produced(await running([...typed("pwd"), control("c"), ENTER])))
        .toEqual(["", "", ""]);
    });

    it("ends the line it was drawing when the keys run out", async () => {
      expect(produced(await running([...typed("pwd")]))).toEqual([""]);
    });
  });

  describe("text the fabric wrote", () => {
    // Neither a refusal's reason nor a thrown read's message passed a door, so
    // neither has been held to the class a terminal acts on. Both are held to
    // it here, where each becomes the line under the one that was typed, and
    // these cases are at that point rather than at either writer for the
    // reason the escaping is: a refusal built as a literal and a `throw` from
    // a module the verbs never see reach the same place by paths no writer
    // covers.

    it("shows a character a terminal acts on, however the refusal was built", async () => {
      // Both rows carry the same fabric-written error and refuse with the same
      // words, and they are built differently: `wish` refuses through the
      // helper, `cd` returns the refusal as a literal while resolving the
      // target. The helper is what an escape at the writer would have covered.

      for (const line of ["wish #favorites", "cd #favorites"]) {
        const writes = await running([...typed(line), ENTER], shuttleIn(), {
          readWish: () =>
            Promise.resolve({ result: null, error: "gone\u009b" }),
        });
        expect(produced(writes)[0]).toBe(
          "`#favorites` resolved to nothing: gone␦",
        );
        expect(/\p{Cc}/u.test(produced(writes)[0])).toBe(false);
      }
    });

    it("answers a read that threw something no message can be read off", async () => {
      // The failure path failing is the case: `String` throws on a value with
      // no `toString`, so the obvious spelling of this catch would throw
      // inside the catch, escape the loop, and end the session on the read
      // that failed. What a reader gets instead says less than a message and
      // far more than a prompt that is gone.

      for (
        const thrown of [
          Object.create(null),
          {
            toString: () => {
              throw new Error("no");
            },
          },
          Object.assign(new Error("x"), { message: { not: "a string" } }),
        ]
      ) {
        const writes = await running([...typed("get"), ENTER], atPiece(), {
          getCellValue: () => Promise.reject(thrown),
        });
        expect(produced(writes)[0]).toBe(
          "The failure carries nothing that can be written as a message.",
        );
      }
    });

    it("reads the line after one that threw something unreadable", async () => {
      // The point of not throwing: the run carries on, which is the whole
      // difference between a bad answer and no shell.

      const writes = await running(
        [...typed("get"), ENTER, ...typed("pwd"), ENTER],
        atPiece(),
        { getCellValue: () => Promise.reject(Object.create(null)) },
      );
      expect(produced(writes).length).toBe(3);
      expect(produced(writes)[1]).toContain("position");
    });

    it("shows one in the message of a read that threw", async () => {
      // A read that throws produces no outcome at all, so it is reached by
      // neither the refusal arm nor the value arm — the catch is its whole
      // path, and the message on it is the server's rather than shuttle's.

      const writes = await running([...typed("get"), ENTER], atPiece(), {
        getCellValue: () => {
          throw new Error("the server said \u009b[2J");
        },
      });
      expect(produced(writes)[0]).toBe("the server said ␦[2J");
      expect(/\p{Cc}/u.test(produced(writes)[0])).toBe(false);
    });
  });

  describe("the bindings", () => {
    it("moves the cursor to the start of the line on `ctrl-a`", async () => {
      const writes = await running([...typed("ab"), control("a")]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 18,
      });
    });

    it("kills the word before the cursor on `ctrl-w`", async () => {
      const writes = await running([...typed("one two"), control("w")]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}one `,
        column: 22,
      });
    });

    it("reads a key's alt modifier as part of what it is bound to", async () => {
      // `alt-b` is the word-backward motion, and `b` is a character to insert.
      // The two are the same key name, so nothing but the modifier tells them
      // apart.

      const writes = await running([...typed("one two"), alt("b")]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}one two`,
        column: 22,
      });
    });

    it("runs the motion each key is bound to", async () => {
      // One case over the whole table, so a binding dropped from it fails here
      // rather than quietly stopping working. Every row is written so that the
      // key under test has somewhere to go: a motion is asked from a cursor it
      // can move from, and a kill is asked where there is something to kill.
      // Read it as the line each sequence leaves behind, and its cursor.

      const HOME: Key = { name: "home" };
      const on = (...keys: Key[]): Key[] => [...typed("one two"), ...keys];
      const bound: [Key[], string, number][] = [
        [on(control("b")), "one two", 24],
        [on({ name: "left" }), "one two", 24],
        [on(HOME, control("f")), "one two", 19],
        [on(HOME, { name: "right" }), "one two", 19],
        [on(control("a")), "one two", 18],
        [on(HOME), "one two", 18],
        [on(HOME, control("e")), "one two", 25],
        [on(HOME, { name: "end" }), "one two", 25],
        [on(alt("b")), "one two", 22],
        [on(HOME, alt("f")), "one two", 21],
        [on({ name: "backspace" }), "one tw", 24],
        [on(HOME, { name: "delete" }), "ne two", 18],
        [on(HOME, control("d")), "ne two", 18],
        [on(HOME, control("k")), "", 18],
        [on(control("u")), "", 18],
        [on(control("w")), "one ", 22],
        [on({ name: "backspace", alt: true }), "one ", 22],
        [on(HOME, alt("d")), " two", 18],
        [on(control("u"), control("y")), "one two", 25],
        // The one row that does not open with `on`, and the only shape that
        // can ask this: yank-pop reaches for the kill before last, so the ring
        // has to hold two and nothing else. Starting from `one two` would put
        // a third kill in it and ask a different question. Read the sequence
        // as: kill `a`, kill `b`, yank back `b`, then pop to `a`.
        [
          [
            ...typed("a"),
            control("u"),
            ...typed("b"),
            control("u"),
            control("y"),
            alt("y"),
          ],
          "a",
          19,
        ],
      ];
      for (const [keys, text, column] of bound) {
        expect(drawn(await running(keys)))
          .toEqual({ kind: "edit", text: `${AT_ROOT}${text}`, column });
      }
    });

    it("leaves the line alone for a character a terminal would act on", async () => {
      // The decoder gives every byte below `0x20` a name and no character, so
      // none of those arrives here. A C1 character does, whole, out of a
      // paste — and `U+009B` is a sequence introducer, which drawn into the
      // line would take the rest of it as a command. No place admits a part
      // holding one either, so a line carrying it is a line already refused.

      const pasted: Key[] = [
        { name: "\u009b", char: "\u009b" },
        { name: "\u001b", char: "\u001b" },
      ];
      const writes = await running([...typed("ab"), ...pasted]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 20,
      });
    });

    it("leaves the line alone for a key bound to nothing that typed nothing", async () => {
      const writes = await running([...typed("ab"), { name: "f1" }]);
      expect(drawn(writes)).toEqual({
        kind: "edit",
        text: `${AT_ROOT}ab`,
        column: 20,
      });
    });
  });
});
