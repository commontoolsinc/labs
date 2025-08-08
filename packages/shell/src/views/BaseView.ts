import { LitElement } from "lit";
import { Command } from "../lib/app/commands.ts";
import { DebugController } from "../lib/debug-controller.ts";

// Set to `true` to render outlines everytime a
// LitElement renders.
const DEBUG_RENDERER = false;

export const SHELL_COMMAND = "shell-command";

export class BaseView extends LitElement {
  // deno-lint-ignore no-unused-vars
  #debugController = new DebugController(this, DEBUG_RENDERER);
  command(command: Command) {
    this.dispatchEvent(
      new CustomEvent(SHELL_COMMAND, {
        detail: command,
        composed: true,
        bubbles: true,
      }),
    );
  }
}
