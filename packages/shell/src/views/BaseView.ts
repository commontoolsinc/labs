import { LitElement } from "lit";
import { Command } from "../lib/commands.ts";

export const SHELL_COMMAND = "shell-command";

export class BaseView extends LitElement {
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
