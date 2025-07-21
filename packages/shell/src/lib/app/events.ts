import { Command } from "./commands.ts";
import { AppState } from "./state.ts";

export class AppUpdateEvent extends Event {
  command: Command;
  state?: AppState;
  error?: Error;

  constructor(
    command: Command,
    { state, error }: { state?: AppState; error?: Error },
  ) {
    super("appupdate");
    this.command = command;
    this.state = state;
    this.error = error;
  }

  // Logs this `AppUpdateEvent` into the global console.
  prettyPrint() {
    const ENTRY_STYLE = "font-weight:bold;";
    const ERROR_STYLE = "font-weight:bold;color:red";
    const RESET_STYLE = "";
    const { command, error, state } = this;
    const { type } = command;
    const jsonCommand = JSON.stringify(command);
    const time = `${(globalThis.performance.now() / 1000).toFixed(3)}s`;
    if (error) {
      const message = error.message;
      const label = `Command|${type}|ERROR`;
      console.groupCollapsed(label);
      console.log(`%cType: %c${type}`, ENTRY_STYLE, RESET_STYLE);
      console.log(`%cCommand: %c${jsonCommand}`, ENTRY_STYLE, RESET_STYLE);
      console.log(`%cError:`, ERROR_STYLE, message);
      console.log(`%cTime: %c${time}`, ENTRY_STYLE, RESET_STYLE);
    } else if (state) {
      const label = `Command|${type}`;
      console.groupCollapsed(label);
      console.log(`%cType: %c${type}`, ENTRY_STYLE, RESET_STYLE);
      console.log(`%cCommand: %c${jsonCommand}`, ENTRY_STYLE, RESET_STYLE);
      console.log(
        `%cState:`,
        ENTRY_STYLE,
        state,
      );
      console.log(`%cTime: %c${time}`, ENTRY_STYLE, RESET_STYLE);
    }
    console.groupEnd();
  }
}
