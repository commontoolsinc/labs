import { Command } from "@cliffy/command";
import { cliText } from "../lib/cli-name.ts";
import { render } from "../lib/render.ts";
import { newSessionId } from "../lib/session.ts";

/**
 * Emit a freshly minted session id. Nothing else goes to stdout: the id is the
 * whole output, so `$(cf session new)` captures exactly it.
 *
 * The `write` seam is the unit-test hold on the command's output — a command
 * action body only ever runs under Cliffy, and is therefore unreachable from
 * the unit suite. Runtime callers use the default.
 */
export function renderNewSession(write: (text: string) => void = render): void {
  write(newSessionId());
}

export const session = new Command()
  .name("session")
  .description(
    "Mint the session `cf piece call --session` names: the caller an " +
      "invocation id was chosen within. One per agent run.",
  )
  .default("help")
  /* session new */
  .command("new", "Output a new session id to stdout.")
  .example(
    cliText("export CF_SESSION=$(cf session new)"),
    "Mint a session for this shell, so every call made from it shares one.",
  )
  .action(() => renderNewSession());
