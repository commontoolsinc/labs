/**
 * The prompt: a line read off the keyboard, handed to the dispatch, and its
 * outcome written under it.
 *
 * This is where a run's output comes from. A verb returns what it did rather
 * than writing it, so everything a line puts on screen passes through here, in
 * the order the person caused it — which is what makes a transcript a record of
 * cause and effect rather than of whatever reached the terminal first. The one
 * thing shuttle writes outside this loop is the entry's own report of a run
 * that could not start.
 *
 * The line editor is the view substrate's rather than `node:readline`'s.
 * `EditBuffer` (`lib/view/editbuffer.ts`) holds the motions and `decodeKeys`
 * (`lib/view/keys.ts`) supplies the keys, so the bindings are a table this
 * module owns — a value, which a second table can stand beside.
 * `node:readline` has no supported place for one: the module exports an
 * interface, three cursor helpers and a keypress decoder, and that interface's
 * prototype carries one public method, `question()` — everything else on it,
 * the key dispatch `_ttyWrite` among them, is underscore-prefixed. A second
 * table behind it means replacing one of those, and the exported half that
 * would have helped, the keypress decoder, is the job `decodeKeys` already
 * does.
 *
 * Nothing here touches a terminal either: the keys arrive as decoded keys and
 * the writing goes through {@link PromptTerminal}, so a case drives the whole
 * loop with a scripted key stream and reads back what it produced.
 */

import { EditBuffer } from "../view/editbuffer.ts";
import type { Key } from "../view/keys.ts";
import {
  escapeControlCharacters,
  escapeControlCharactersInJson,
  holdsControlCharacter,
  messageOf,
} from "./place.ts";
import { runLine, type Shuttle, type VerbDeps } from "./verbs.ts";

/** What the prompt opens every line with, before the place it carries. */
const PROMPT_NAME = "shuttle";

/**
 * Where the prompt reads its keys and writes what it has to write.
 *
 * The two writes are different acts and not one. {@link PromptTerminal.edit}
 * shows a line that is still being typed, and may be called any number of
 * times for one line; {@link PromptTerminal.finish} ends that line and puts
 * what it produced under it, once.
 */
export interface PromptTerminal {
  /**
   * The keys the person typed, in order, ending when their input does — which
   * ends the run.
   */
  readonly keys: AsyncIterable<Key>;

  /**
   * Shows `text` as the line being edited, with the cursor `column` code
   * points into it. Both are the whole line, prompt included, because where
   * the prompt ends and the typing begins is nothing a terminal needs to know.
   */
  edit(text: string, column: number): void;

  /**
   * Ends the line being edited, leaving it where it was shown, and writes
   * `text` under it — nothing under it where `text` is empty.
   */
  finish(text: string): void;
}

/**
 * Reads lines against `shuttle` until `terminal` runs out of keys, and returns
 * once it has.
 *
 * Every line goes to `runLine`, and what comes back is written under it: text
 * a verb composed, a value the fabric holds, or the reason a line was refused.
 * A read that failed reaches here as a throw rather than as an outcome, and is
 * written under the line the same way — the difference the seam draws is that
 * a shell whose server went away is still a shell, so this reports it and
 * reads the next line where a one-shot command would exit.
 *
 * Two keys end a line rather than editing it. `enter` runs it. `ctrl-d` on an
 * empty line ends the run, which is the end-of-input every shell spells that
 * way, and on a line with anything on it deletes forward instead. `ctrl-c`
 * abandons the line and starts a new one, so what it interrupts is the typing
 * and never the run.
 */
export async function runPrompt(
  shuttle: Shuttle,
  terminal: PromptTerminal,
  deps: VerbDeps = {},
): Promise<void> {
  const buffer = new EditBuffer("");
  let prompt = promptFor(shuttle);
  const show = () =>
    terminal.edit(
      `${prompt}${buffer.text()}`,
      codePoints(prompt) + buffer.col,
    );
  show();
  for await (const key of terminal.keys) {
    if (key.name === "ctrl-d" && buffer.text() === "") break;
    if (key.name === "enter") {
      terminal.finish(await report(buffer.text(), shuttle, deps));
      buffer.setText("");
      // After the line, not before it: `cd` is what moves the place, so the
      // prompt a line is typed at is the place it is read against.
      prompt = promptFor(shuttle);
    } else if (key.name === "ctrl-c") {
      terminal.finish("");
      buffer.setText("");
    } else {
      apply(buffer, key);
    }
    show();
  }
  terminal.finish("");
}

/**
 * The motions a key runs, by the key that runs it. Emacs bindings, because
 * they are what the substrate's own editor binds and what a terminal's other
 * line editors offer.
 *
 * A `Map` rather than an object, which holds what was put in it and answers
 * for nothing else — the shape the verb table takes, for the same reason and
 * against a wider door. What reaches this one is narrower: a key name is a
 * single character, a `ctrl-` or `alt-` compound, or one of the fixed names
 * `decodeKeys` writes, and none of those is a member every object carries.
 *
 * `ctrl-d` deletes forward here and ends the run in {@link runPrompt}, which
 * reads it first: what the two spellings have in common is that each removes
 * what is in front of the cursor, and on an empty line there is only the run.
 */
const BINDINGS: ReadonlyMap<string, (buffer: EditBuffer) => void> = new Map([
  ["left", (buffer) => buffer.moveLeft()],
  ["ctrl-b", (buffer) => buffer.moveLeft()],
  ["right", (buffer) => buffer.moveRight()],
  ["ctrl-f", (buffer) => buffer.moveRight()],
  ["home", (buffer) => buffer.moveLineStart()],
  ["ctrl-a", (buffer) => buffer.moveLineStart()],
  ["end", (buffer) => buffer.moveLineEnd()],
  ["ctrl-e", (buffer) => buffer.moveLineEnd()],
  ["alt-b", (buffer) => buffer.moveWordBackward()],
  ["alt-f", (buffer) => buffer.moveWordForward()],
  ["backspace", (buffer) => buffer.deleteBackward()],
  ["delete", (buffer) => buffer.deleteForward()],
  ["ctrl-d", (buffer) => buffer.deleteForward()],
  ["ctrl-k", (buffer) => buffer.killLine()],
  ["ctrl-u", (buffer) => buffer.killWholeLine()],
  ["ctrl-w", (buffer) => buffer.killWordBackward()],
  ["alt-backspace", (buffer) => buffer.killWordBackward()],
  ["alt-d", (buffer) => buffer.killWordForward()],
  ["ctrl-y", (buffer) => buffer.yank()],
  ["alt-y", (buffer) => buffer.yankPop()],
]);

/**
 * Helper for {@link runPrompt}, which is the prompt `shuttle` currently
 * carries.
 *
 * The place is carried short, and the shortening is the one that costs
 * nothing: the space is left out, because one connection serves one space and
 * a value that cannot change while you read it tells you nothing. Everything
 * else is written out — no name this process did not read, no id cut down to
 * a prefix that would print exactly as a whole one.
 *
 * So the prompt is not an address, and `pwd` is what to copy. The two halves
 * are separated by a space rather than joined, which is what keeps each of
 * them a word of its own: the scope suffix sits last on every form here,
 * where a reference carries it on the piece, because a prompt wants it in the
 * same column on every line and a reference wants it where its grammar puts
 * it.
 */
function promptFor(shuttle: Shuttle): string {
  return `${PROMPT_NAME} ${shuttle.place.label()}> `;
}

/**
 * Helper for {@link runPrompt}, which runs `line` and returns what to write
 * under it — the empty string where it produced nothing to say.
 *
 * A value prints as indented JSON, and what cannot be written that way is
 * said rather than shown — by {@link written} for a value the writer declines,
 * and by the catch here for one it cannot walk at all, a cycle among them.
 * Either way the line is answered and the run carries on, which is what a read
 * that failed gets too.
 *
 * Reading the message off a thrown value is `messageOf`'s and not this
 * expression's, because the obvious spelling of it throws on values a
 * rejection can carry, and a throw raised while answering a failure is the
 * failure this catch exists to stop.
 *
 * The two prose answers are escaped here rather than where they were written.
 * A refusal's reason and a thrown read's message both carry text the fabric
 * wrote, which passed no door and so was never held to the class a terminal
 * acts on; and both reach a person only by becoming the line under this one.
 * Escaping at that point covers a refusal built as a literal rather than
 * through `refuse`, and a message from a `throw` this module never sees, in a
 * way that escaping at each site cannot. It leaves the other two arms alone
 * because each owns a convention this one would undo: a rendered record and a
 * listing are laid out with line breaks that are structure rather than
 * content, and a serialized value is already escaped in JSON's own spelling.
 */
async function report(
  line: string,
  shuttle: Shuttle,
  deps: VerbDeps,
): Promise<string> {
  try {
    const outcome = await runLine(line, shuttle, deps);
    switch (outcome.kind) {
      case "nothing":
      case "moved":
        return "";
      case "text":
        return outcome.text;
      case "refused":
        return escapeControlCharacters(outcome.reason);
      case "value":
        return written(outcome.value);
    }
  } catch (thrown) {
    return escapeControlCharacters(messageOf(thrown));
  }
}

/**
 * Helper for {@link report}, which is `value` as the reader sees it.
 *
 * `JSON.stringify` returns no string for several different reasons and says
 * which for none of them, so this tells them apart before it is asked. A
 * value that is `undefined` is what the fabric holds nothing at, and the word
 * says so. A registry-interned symbol is a value a cell does hold and JSON
 * has no form for, and the word there would say the cell was empty when it is
 * not, so what comes back names the kind instead.
 *
 * A `bigint` is a value a cell holds too, and the writer throws on one rather
 * than declining it, so it is given a form on the way past: `{ $bigint: "…" }`
 * with the number as its decimal string, which is what `cf cell get` writes
 * for the same value (`safeStringify`, `render.ts`). One question answered
 * twice ought to be answered the same way, and a test compares the two rather
 * than restating the spelling.
 *
 * Where the two surfaces still differ they differ on purpose, and this is the
 * one that is right: `cf cell get` writes `null` both for a value that is
 * `undefined` and for a symbol, and `null` is a value a cell can hold. What
 * a cell holds nothing at is nothing, and the word above says that instead.
 *
 * The bound is on nesting rather than on a kind, and it is what a caller
 * cannot see. An `undefined` or an interned symbol under a key loses the key,
 * which reads as a key the fabric does not hold; either of them at an array
 * index, and an array's hole, is written `null`, which reads as a value the
 * fabric holds. Every one of those is a value a cell takes and hands back,
 * and a read produces them without being asked: a property a schema does not
 * require reads as `undefined` where the data underneath does not match it
 * (`schema-view.ts`). A function and a unique symbol are not bounds here,
 * because neither survives to be read out of a cell. The fabric's
 * value-admission test refuses both on the way in
 * (`assertValidFabricValueLayer`, `packages/data-model/src/type-check.ts`),
 * and its codec has no form for either at the commit that would store one
 * (`BaseEncodeAct`), so the raw write that skips the first still meets the
 * second.
 *
 * What the writer leaves for this one to do is the class a terminal acts on.
 * It escapes every C0 character a value held and passes `DEL` and C1 through,
 * so those are finished here, in JSON's own spelling rather than the glyphs a
 * message gets — the two conventions and the reason they differ are with
 * `escapeControlCharactersInJson` (`place.ts`).
 */
function written(value: unknown): string {
  if (value === undefined) return "undefined";
  const json = JSON.stringify(
    value,
    (_key, held) =>
      typeof held === "bigint" ? { $bigint: held.toString() } : held,
    2,
  );
  return json === undefined
    ? `The value is a ${typeof value}, which JSON has no way to write.`
    : escapeControlCharactersInJson(json);
}

/**
 * Helper for {@link runPrompt}, which lets `key` act on `buffer`: the motion
 * it is bound to, or the character it produced where it is bound to none.
 *
 * A key carrying a modifier produces no character, so a binding and an
 * insertion never both apply, and a key that is neither does nothing.
 *
 * A character a terminal acts on rather than prints is one of those neithers.
 * The decoder gives every byte below `0x20` a name and no character, so none
 * of those reaches here at all; what does is a C1 character, which arrives
 * whole out of a paste — and `U+009B` is a sequence introducer, which drawn
 * into the line would take the rest of it as a command. There is nowhere for
 * such a character to be going: no place admits a part holding one
 * (`place.ts`), so a line carrying one is a line already refused, and drawing
 * it would corrupt the screen on the way to that refusal.
 */
function apply(buffer: EditBuffer, key: Key): void {
  const motion = BINDINGS.get(key.alt === true ? `alt-${key.name}` : key.name);
  if (motion !== undefined) {
    motion(buffer);
    return;
  }
  if (key.char !== undefined && !holdsControlCharacter(key.char)) {
    buffer.insert(key.char);
  }
}

/**
 * Helper for {@link runPrompt}, which is the length of `text` in the unit the
 * cursor is measured in. The buffer counts a code point as a column, and this
 * counts the prompt in front of it the same way.
 */
function codePoints(text: string): number {
  return [...text].length;
}
