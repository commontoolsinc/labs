/**
 * Running a shuttle: one connection, one place, and the prompt over both, for
 * as long as the person keeps typing.
 *
 * This is what `cf sh` calls. The terminal opens first and the connection
 * inside it, because the terminal is where the connection's own writing has to
 * land: a pattern's console output and the lines a connect writes for itself
 * would otherwise reach the process's streams, which is the middle of the
 * drawing once a prompt is painted (`announce.ts`). The connect then happens
 * before the first line rather than on it, because the place cannot be built
 * without it: a space written as a name is a DID only once a session has
 * resolved it, and a place stands in a space. That is the connect a shell pays
 * once where a one-shot command pays it per invocation.
 *
 * Nothing here reads the command line. What a person wrote is read by the
 * command, in the words every other command reads a space and an identity in,
 * and what arrives is the connection it settled on.
 */

import { loadPieces, type SpaceConfig } from "../piece.ts";
import { announcingOutput } from "./announce.ts";
import { type ConnectionOpener, HeldConnection } from "./connection.ts";
import { CurrentPlace } from "./place.ts";
import { runPrompt } from "./prompt.ts";
import { ShuttleSession } from "./session.ts";
import { consoleColumns, consoleRows, withPromptTerminal } from "./terminal.ts";
import type { Shuttle } from "./verbs.ts";

/** What a run reaches the world through, so that a case can stand for it. */
export interface ShuttleDeps {
  /**
   * Opens the connection; `loadPieces` where a caller names none. It takes
   * the output bag as well as the config, because where the connection's own
   * writing goes is this module's decision rather than the holder's.
   */
  readonly open?: typeof loadPieces;

  /** Holds a terminal open for the prompt to read and write through. */
  readonly terminal?: typeof withPromptTerminal;
}

/**
 * Runs a shuttle over `config`, returning when the person ends the session.
 *
 * The connection is this call's to close, so it is closed on the way out
 * whatever ended the run — a line that ended it, or a throw from anywhere
 * under the prompt. A terminal that will not open is the one way out that
 * closes nothing, and closes nothing because nothing was opened: the terminal
 * is what the connection is opened inside.
 *
 * @throws Whatever opening the terminal or the connection throws, and whatever
 * the prompt throws that it did not report as a line's own failure.
 */
export async function runShuttle(
  config: SpaceConfig,
  deps: ShuttleDeps = {},
): Promise<void> {
  await (deps.terminal ?? withPromptTerminal)(async (terminal) => {
    const opening = deps.open ?? loadPieces;
    const output = announcingOutput((text) => terminal.announce(text));
    const open: ConnectionOpener = (opened) => opening(opened, output);
    await using connection = new HeldConnection({
      kind: "owned",
      record: config,
      open,
    });
    const pieces = await connection.pieces();
    const shuttle: Shuttle = {
      config,
      place: new CurrentPlace(pieces.getSpace()),
      connection,
      session: new ShuttleSession(),
    };
    // How big the screen is arrives as functions rather than numbers, so a
    // window resized mid-session bounds the next line at the size it has then.
    // Both dimensions ride the deps bag because that is what already reaches
    // every verb, and a verb writing a page is where both are wanted: a page
    // is measured in rows, and a line becomes rows at the width.
    await runPrompt(shuttle, terminal, {
      rows: consoleRows,
      columns: consoleColumns,
    });
  });
}
