import { LitElement } from "lit";

import { Command } from "../lib/commands.ts";

export const SHELL_COMMAND = "shell-command";
export const SHELL_COMMAND_RESULT = "shell-command-result";

export interface CommandResultEvent extends Event {
  commandId: string;
  command: Command;
  error?: Error;
}

export class BaseView extends LitElement {
  private _commandResolvers = new Map<string, {
    resolve: (value: void) => void;
    reject: (error: Error) => void;
  }>();

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener(SHELL_COMMAND_RESULT, this._handleCommandResult as EventListener);
  }

  override disconnectedCallback() {
    this.removeEventListener(SHELL_COMMAND_RESULT, this._handleCommandResult as EventListener);
    super.disconnectedCallback();
  }

  private _handleCommandResult = (event: CommandResultEvent) => {
    const { commandId, error } = event;
    const resolver = this._commandResolvers.get(commandId);
    if (resolver) {
      this._commandResolvers.delete(commandId);
      if (error) {
        resolver.reject(error);
      } else {
        resolver.resolve();
      }
    }
  };

  command(command: Command): Promise<void> {
    const commandId = crypto.randomUUID();
    
    return new Promise((resolve, reject) => {
      this._commandResolvers.set(commandId, { resolve, reject });
      
      this.dispatchEvent(
        new CustomEvent(SHELL_COMMAND, {
          detail: { command, commandId },
          composed: true,
          bubbles: true,
        }),
      );
    });
  }
}
