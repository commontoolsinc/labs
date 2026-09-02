import { Command } from "@cliffy/command";

import { reservesStdoutForCommandOutput } from "../lib/json-output.ts";
import { cliText } from "../lib/cli-name.ts";
import {
  buildGetLabelCommand,
  buildSetLabelCommand,
  pieceDataCommand,
} from "./piece.ts";

/**
 * `cf cell` — the commands that act on a cell.
 *
 * Reading and writing a value, and reading and writing the CFC label on one,
 * all act on a cell rather than on the piece that happens to own it. The
 * address these take has never been piece-specific: it names a cell, which is
 * why the option that carries it is spelled `--cell`.
 *
 * Each subcommand attaches the target options itself rather than inheriting
 * them from this noun, because one definition of each is mounted twice while
 * the superseded spelling is still answered.
 */
// deno-lint-ignore no-explicit-any
export const cell: Command<any> = new Command()
  .name("cell")
  .description(
    cliText(`Read and write cells, and the CFC labels on them.

A cell is named by an address — an entity id, a slug, or a URL — with an
optional path into the value it holds, and a trailing "#argument" to reach the
arguments cell instead of the result.`),
  )
  .error((error, command) => {
    // A refusal must not reach stdout on the commands that reserve it for
    // machine-readable output; the same rule `cf piece` follows.
    const args = command.getMainCommand().getRawArgs();
    if (reservesStdoutForCommandOutput(args)) {
      throw error;
    }
  })
  .default("help")
  /* cell get */
  .command("get", pieceDataCommand("get", { spelling: "cell get" }))
  /* cell set */
  .command("set", pieceDataCommand("set", { spelling: "cell set" }))
  /* cell get-label */
  .command("get-label", buildGetLabelCommand("cell get-label"))
  /* cell set-label */
  .command("set-label", buildSetLabelCommand("cell set-label"));
