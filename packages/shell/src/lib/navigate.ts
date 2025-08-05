import { App } from "./app/controller.ts";
import { USE_SHELL_PREFIX } from "./env.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("shell.navigation");

// Could contain other nav types, like external pages,
// or viewing a User's "Settings" etc.
export type NavigationCommandType = "charm" | "space";

export type NavigationCommand = {
  type: "charm";
  charmId: string;
  spaceName: string;
} | {
  type: "space";
  spaceName: string;
};

const NavigationEventName = "ct-navigate";

class NavigationEvent extends CustomEvent<NavigationCommand> {
  command: NavigationCommand;
  constructor(command: NavigationCommand) {
    super(NavigationEventName, { detail: command });
    this.command = command;
  }
}

export function navigate(command: NavigationCommand) {
  globalThis.dispatchEvent(new NavigationEvent(command));
}

const UpdatePageTitleEventName = "ct-update-page-title";

class UpdatePageTitleEvent extends CustomEvent<string> {
  title: string;
  constructor(title: string) {
    super(UpdatePageTitleEventName, { detail: title });
    this.title = title;
  }
}

export function updatePageTitle(title: string) {
  globalThis.dispatchEvent(new UpdatePageTitleEvent(title));
}

// Handles synchronizing of browser history state and application state.
//
// Navigation can occur in the following scenarios:
// * Browser back/forward buttons/shortcuts
// * Clicking on a `<x-charm-link>`
//
// On instantiation, parses the current URL and applies app state as needed.
export class Navigation {
  #app: App;
  constructor(app: App) {
    this.#app = app;

    globalThis.addEventListener(NavigationEventName, this.onNavigate);
    globalThis.addEventListener(
      UpdatePageTitleEventName,
      this.onUpdatePageTitle,
    );
    globalThis.addEventListener("popstate", this.onPopState);

    const init = generateCommandFromPageLoad();
    // Initial state is `null` -- reflect the state given
    // from the current URL.
    this.replace(init);
    this.apply(init);
  }

  private onUpdatePageTitle = (e: Event) => {
    const title = (e as UpdatePageTitleEvent).title;
    logger.log("SetTitle", title);
    // Thought this needed to interact with the history.
    // Maybe it doesn't.
    document.title = title;
  };

  private onPopState = (e: Event) => {
    const state = (e as PopStateEvent).state as NavigationCommand | null;
    logger.log("Pop", state);
    if (!state) {
      console.warn("No state from history!");
      return;
    }
    this.apply(state);
  };

  private onNavigate = (e: Event) => {
    const command = (e as NavigationEvent).command;
    logger.log("Navigate", command);
    this.push(command);
    this.apply(command);
  };

  // Push a new command state to the browser's history.
  private push(command: NavigationCommand) {
    logger.log("Push", command);
    globalThis.history.pushState(command, "", getNavigationHref(command));
  }

  // Updates the current browser history state and page with a new title.
  private replace(command: NavigationCommand, title?: string) {
    logger.log("Replace", command, title);
    globalThis.history.replaceState(
      command,
      title || "",
      getNavigationHref(command),
    );
  }

  // Propagates the command state into the App.
  private apply(command: NavigationCommand) {
    logger.log("Apply", command);
    switch (command.type) {
      case "charm": {
        this.#app.setSpace(command.spaceName);
        this.#app.setActiveCharmId(command.charmId);
        break;
      }
      case "space": {
        this.#app.setSpace(command.spaceName);
        this.#app.setActiveCharmId(undefined);
        break;
      }
      default: {
        throw new Error("Unsupported navigation type.");
      }
    }
  }
}

function getNavigationHref(command: NavigationCommand): string {
  let content = "";
  switch (command.type) {
    case "charm": {
      content = `${command.spaceName}/${command.charmId}`;
      break;
    }
    case "space": {
      content = `${command.spaceName}`;
      break;
    }
    default: {
      throw new Error("Unsupported navigation type.");
    }
  }
  const prefix = USE_SHELL_PREFIX ? `/shell` : "";
  return `${prefix}/${content}`;
}

function generateCommandFromPageLoad(): NavigationCommand {
  const location = new URL(globalThis.location.href);
  const segments = location.pathname.split("/");
  segments.shift(); // shift off the pathnames' prefix "/";
  const [first, charmId] = USE_SHELL_PREFIX
    ? [segments[1], segments[2]]
    : [segments[0], segments[1]];

  const spaceName = first || "common-knowledge";
  if (charmId) {
    return { type: "charm", spaceName, charmId };
  } else {
    return { type: "space", spaceName };
  }
}
