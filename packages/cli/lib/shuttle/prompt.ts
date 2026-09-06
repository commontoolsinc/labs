/**
 * The prompt: a line read off the keyboard, handed to the dispatch, and its
 * outcome written above the line being typed next.
 *
 * This is where a run's output comes from. A verb returns what it did rather
 * than writing it, so everything a line puts on screen passes through here, in
 * the order the person caused it — which is what makes a transcript a record of
 * cause and effect rather than of whatever reached the terminal first. The one
 * thing shuttle writes outside this loop is the entry's own report of a run
 * that could not start.
 *
 * It is an event loop rather than a read-then-run: the keys are read
 * continuously and a running line is a task beside them, so a line that is
 * waiting on a server holds up neither the keyboard nor the screen. Two things
 * follow, and they are the whole reason for the shape. `ctrl-c` reaches a line
 * that is already running, which is the only way a shell whose server has gone
 * quiet is still a shell. And a key typed during that wait is drawn as it
 * arrives instead of being queued unseen and run blind afterwards.
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
import { type Outcome, runLine, type Shuttle, type VerbDeps } from "./verbs.ts";

/** What the prompt opens every line with, before the place it carries. */
const PROMPT_NAME = "shuttle";

/** What a line that was cancelled leaves behind it. */
const INTERRUPTED = "Interrupted.";

/**
 * Where the prompt reads its keys and writes what it has to write.
 *
 * The three writes are different acts and not one. {@link PromptTerminal.edit}
 * shows a line that is still being typed, and may be called any number of
 * times for one line; {@link PromptTerminal.finish} ends that line, once; and
 * {@link PromptTerminal.announce} puts a line above the one being typed, which
 * is where everything a run has to say lands, whether or not a line is in
 * flight when it is said.
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

  /** Ends the line being edited, leaving it where it was shown. */
  finish(): void;

  /**
   * Writes `text` above the line being edited, and draws that line again
   * beneath it.
   *
   * This is the out-of-band line, and it is one door with three producers: a
   * line's own outcome, written when the line settles rather than when it was
   * typed; the runtime's console and the warnings a connection writes for
   * itself (`announce.ts`); and, when watches arrive, an event line per
   * settled change. What the last two carry is a user program's own output,
   * which passed no door of shuttle's, so an implementation holds `text` to
   * the class a terminal acts on before any of it is sent — `above`
   * (`paint.ts`) is where the one this package uses does it. A line feed in
   * `text` is a row, and every other character of that class is shown as the
   * glyph naming it.
   */
  announce(text: string): void;
}

/**
 * Reads lines against `shuttle` until `terminal` runs out of keys, and returns
 * once it has and once the line it was running has settled.
 *
 * Every line goes to `runLine`, and what comes back is written above the line
 * being typed next: text a verb composed, a value the fabric holds, or the
 * reason a line was refused. A read that failed reaches here as a throw rather
 * than as an outcome, and is written the same way — the difference the seam
 * draws is that a shell whose server went away is still a shell, so this
 * reports it and reads the next line where a one-shot command would exit.
 *
 * One line runs at a time, and the keys keep arriving while it does. Three
 * keys mean something other than editing:
 *
 * - `enter` runs the line. Pressed while a line is in flight it is held,
 *   along with every key after it, and the held keys are replayed the moment
 *   the prompt is free — so a pasted script runs line by line, each against
 *   the place the line before it settled on, and nothing runs against a
 *   prompt that has already moved.
 * - `ctrl-d` on an empty line ends the run, which is the end-of-input every
 *   shell spells that way, and on a line with anything on it deletes forward
 *   instead. On an empty line while a line is in flight it is held, as
 *   `enter` is.
 * - `ctrl-c` cancels: the line in flight, or the line being typed where none
 *   is. It is never held, and it drops what was typed ahead of it, which is
 *   what a terminal does with type-ahead when the interrupt arrives.
 *
 * Cancelling is honest about what it can reach. The line is abandoned and the
 * prompt comes back, but a read already sent to the server is not something
 * this can call off: it finishes into nothing, and the checks along the way
 * are what stop it taking effect — a `cd` cancelled after its read returned
 * does not move (`verbs.ts`).
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

  const keys = terminal.keys[Symbol.asyncIterator]();
  /** The key stream's next answer, once asked for and until it is used. */
  let typing: Promise<Arrival> | undefined;
  /** The line in flight, and the whole of what may cancel it. */
  let running: Running | undefined;
  /** Keys read while a line was in flight, from the first line-ender on. */
  let held: Key[] = [];
  /** Whether the keys have run out, which ends the run once nothing is left. */
  let ended = false;

  /** Acts on `key` at a prompt with no line in flight. */
  const act = (key: Key): void => {
    if (key.name === "ctrl-c") {
      terminal.finish();
      buffer.setText("");
    } else if (endsLine(key, buffer)) {
      if (key.name === "ctrl-d") {
        ended = true;
        held = [];
        return;
      }
      const line = buffer.text();
      terminal.finish();
      buffer.setText("");
      running = start(line, shuttle, deps);
      // Nothing is drawn: the prompt for the next line appears when the line
      // settles, or when a key is typed before it does, so a line that
      // answers before anyone types looks exactly as it did when the loop
      // waited for it.
      return;
    } else {
      apply(buffer, key);
    }
    show();
  };

  while (!(ended && running === undefined && held.length === 0)) {
    if (running === undefined && held.length > 0) {
      act(held.shift()!);
      continue;
    }
    if (!ended) typing ??= nextKey(keys);
    const arrival = await (
      ended
        ? running!.settled
        : running === undefined
        ? typing!
        : Promise.race([typing!, running.settled])
    );
    if (arrival.kind === "ran") {
      running = undefined;
      if (arrival.text !== "") terminal.announce(arrival.text);
      // After the line, not before it: `cd` is what moves the place, so the
      // prompt a line is typed at is the place it was read against.
      prompt = promptFor(shuttle);
      show();
      continue;
    }
    typing = undefined;
    if (arrival.step.done) {
      ended = true;
      continue;
    }
    const key = arrival.step.value;
    if (running === undefined) {
      act(key);
    } else if (key.name === "ctrl-c") {
      running.stop();
      held = [];
      buffer.setText("");
      show();
    } else if (held.length > 0 || endsLine(key, buffer)) {
      held.push(key);
    } else {
      apply(buffer, key);
      show();
    }
  }
  terminal.finish();
}

/** What the loop is waiting on: the next key, or the line it is running. */
type Arrival =
  /** The key stream answered, with a key or with the end of the keys. */
  | { readonly kind: "typed"; readonly step: IteratorResult<Key> }
  /** The line in flight settled, and `text` is what it produced. */
  | { readonly kind: "ran"; readonly text: string };

/** A line in flight: what it will produce, and how to cancel it. */
interface Running {
  /** Settles with what the line produced, cancelled or not. */
  readonly settled: Promise<Arrival>;

  /** Cancels the line, which settles it with what a cancelled line says. */
  stop(): void;
}

/**
 * Helper for {@link runPrompt}, which asks `keys` for the next one.
 *
 * It is a function so that the answer is a value the loop holds until it uses
 * it: a key asked for while a line was running is still the next key when that
 * line settles, and asking twice would drop one.
 */
function nextKey(keys: AsyncIterator<Key>): Promise<Arrival> {
  return keys.next().then((step) => ({ kind: "typed", step }) as const);
}

/**
 * Helper for {@link runPrompt}, which starts `line` and returns what running
 * it is.
 *
 * The signal rides the deps bag the verbs already read their collaborators
 * through, so a verb honors it wherever it has a phase to stop between and
 * nothing else has to be threaded to reach one.
 */
function start(line: string, shuttle: Shuttle, deps: VerbDeps): Running {
  const stopper = new AbortController();
  return {
    stop: () => stopper.abort(),
    settled: report(line, shuttle, { ...deps, signal: stopper.signal })
      .then((text) => ({ kind: "ran", text }) as const),
  };
}

/**
 * Helper for {@link runPrompt}, which is whether `key` ends the line `buffer`
 * holds rather than editing it.
 *
 * These are the two keys a prompt cannot honor while a line is in flight —
 * one would run a second line and the other would end the run under the first
 * — so they are the two that are held, and this is the one place that says
 * which they are.
 */
function endsLine(key: Key, buffer: EditBuffer): boolean {
  return key.name === "enter" ||
    (key.name === "ctrl-d" && buffer.text() === "");
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
 * them a word of its own: the scope qualifier sits last on every form here,
 * where a reference carries it on the piece, because a prompt wants it in the
 * same column on every line and a reference wants it where its grammar puts
 * it.
 */
function promptFor(shuttle: Shuttle): string {
  return `${PROMPT_NAME} ${shuttle.place.label()}> `;
}

/**
 * Helper for {@link start}, which runs `line` and returns what to write above
 * the next one — the empty string where it produced nothing to say.
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
 * A cancelled line is answered by whichever of two things happens first, and
 * the answer is the same word either way. The line may reach a phase boundary
 * and stop there, which is the arm `runLine` returns; or it may be waiting on
 * a read that nothing can call off, and then the signal answers for it and the
 * read finishes into nothing. What the second delivers is the prompt, which is
 * what a person pressing `ctrl-c` at a server that has gone quiet is asking
 * for; what it does not deliver is a server that stopped working, and no
 * caller of a read here can deliver that.
 *
 * The two prose answers are escaped here rather than where they were written.
 * A refusal's reason and a thrown read's message both carry text the fabric
 * wrote, which passed no door and so was never held to the class a terminal
 * acts on; and both reach a person only by becoming a line of their own.
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
    const running = runLine(line, shuttle, deps);
    const outcome = await (deps.signal === undefined
      ? running
      : Promise.race([running, abandoned(deps.signal)]));
    switch (outcome.kind) {
      case "nothing":
      case "moved":
        return "";
      case "interrupted":
        return INTERRUPTED;
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
 * Helper for {@link report}, which settles once `signal` is aborted and never
 * otherwise.
 *
 * A promise that never settles is exactly what is wanted for a line nobody
 * cancels: it loses every race it is in and is collected with the controller
 * the line held. Nothing here waits on a clock, so a line that is slow is a
 * line that is still running.
 */
function abandoned(signal: AbortSignal): Promise<Outcome> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ kind: "interrupted" }), {
      once: true,
    });
  });
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
