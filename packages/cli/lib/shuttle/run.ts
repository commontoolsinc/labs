/**
 * Running a shuttle: one connection, one place, and the prompt over both, for
 * as long as the person keeps typing.
 *
 * This is what `cf sh` calls. The connection opens here rather than on the
 * first read, because the place cannot be built without it: a space written as
 * a name is a DID only once a session has resolved it, and a place stands in a
 * space. That is the connect a shell pays once where a one-shot command pays
 * it per invocation.
 *
 * Nothing here reads the command line. What a person wrote is read by the
 * command, in the words every other command reads a space and an identity in,
 * and what arrives is the connection it settled on.
 */

import type { SpaceConfig } from "../piece.ts";
import { type ConnectionOpener, HeldConnection } from "./connection.ts";
import { CurrentPlace } from "./place.ts";
import { runPrompt } from "./prompt.ts";
import { withPromptTerminal } from "./terminal.ts";
import type { Shuttle } from "./verbs.ts";

/** What a run reaches the world through, so that a case can stand for it. */
export interface ShuttleDeps {
  /** Opens the connection; `loadPieces` where a caller names none. */
  readonly open?: ConnectionOpener;

  /** Holds a terminal open for the prompt to read and write through. */
  readonly terminal?: typeof withPromptTerminal;
}

/**
 * Runs a shuttle over `config`, returning when the person ends the session.
 *
 * The connection is this call's to close, so it is closed on the way out
 * whatever ended the run — a line that ended it, a terminal that could not be
 * opened, or a throw from anywhere under the prompt.
 *
 * @throws Whatever opening the connection throws, and whatever the prompt
 * throws that it did not report as a line's own failure — a terminal that is
 * not one among them.
 */
export async function runShuttle(
  config: SpaceConfig,
  deps: ShuttleDeps = {},
): Promise<void> {
  await using connection = new HeldConnection({
    kind: "owned",
    record: config,
    open: deps.open,
  });
  const pieces = await connection.pieces();
  const shuttle: Shuttle = {
    config,
    place: new CurrentPlace(pieces.getSpace()),
    connection,
  };
  await (deps.terminal ?? withPromptTerminal)((terminal) =>
    runPrompt(shuttle, terminal)
  );
}
