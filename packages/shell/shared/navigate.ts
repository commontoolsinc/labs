import { App, AppView, appViewToUrlPath, urlToAppView } from "./app/mod.ts";
import { getLogger } from "@commontools/utils/logger";

const logger = getLogger("shell.navigation", {
  enabled: false,
  level: "debug",
});

export type NavigationCommand = AppView;

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
// * Clicking on a `<x-piece-link>`
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

    const thisUrl = new URL(globalThis.location.href);
    const init = urlToAppView(thisUrl);
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
    let command = (e as NavigationEvent).command;
    logger.log("Navigate", command);
    command = mapNavigationView(this.#app, command);
    this.push(command);
    this.apply(command);
  };

  // Push a new command state to the browser's history.
  private push(command: NavigationCommand) {
    logger.log("Push", command);
    globalThis.history.pushState(command, "", appViewToUrlPath(command));
  }

  // Updates the current browser history state and page with a new title.
  private replace(command: NavigationCommand, title?: string) {
    logger.log("Replace", command, title);
    globalThis.history.replaceState(
      command,
      title || "",
      appViewToUrlPath(command),
    );
  }

  // Propagates the command state into the App.
  private apply(command: NavigationCommand) {
    logger.log("Apply", command);
    this.#app.setView(command);
  }
}

// Navigation events from the DOM use cell references which contain
// a space DID, but no reference to space name. Map these navigation
// events to use a space name if it's the same as the active runtime
// to preserve space name in navigation/URL bar.
function mapNavigationView(
  app: App,
  view: NavigationCommand,
): NavigationCommand {
  const currentView = app.state().view;
  const currentSpaceName = "spaceName" in currentView
    ? currentView.spaceName
    : undefined;
  const currentSpaceDID = app.element().getRuntimeSpaceDID();
  if (
    "spaceDid" in view && view.spaceDid && currentSpaceName &&
    view.spaceDid === currentSpaceDID
  ) {
    return {
      ...("pieceId" in view ? { pieceId: view.pieceId } : undefined),
      spaceName: currentSpaceName,
    };
  }
  return view;
}
