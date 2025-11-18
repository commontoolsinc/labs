import { LitElement } from "lit";
import { Command } from "../lib/app/commands.ts";
import { DebugController } from "@commontools/ui";

// Set to `true` to render outlines everytime a
// LitElement renders.
const DEBUG_RENDERER = false;

export const SHELL_COMMAND = "shell-command";

export class BaseView extends LitElement {
  #_debugController = new DebugController(this, DEBUG_RENDERER);
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
