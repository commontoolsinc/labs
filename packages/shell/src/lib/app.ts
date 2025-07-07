import { ANYONE, Identity, Session } from "@commontools/identity";
import { Command } from "./commands.ts";

export interface AppState {
  identity?: Identity;
  spaceName?: string;
  activeCharmId?: string;
  session?: Session;
  apiUrl: URL;
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state);
}

export async function applyCommand(
  state: AppState,
  command: Command,
): Promise<AppState> {
  const next = clone(state);
  switch (command.type) {
    case "set-identity": {
      next.identity = command.identity;
      next.session = undefined;
      break;
    }
    case "set-space": {
      next.spaceName = command.spaceName;
      next.session = undefined;
      break;
    }
  }
  // If space or identity was set, and session reset,
  // compute a Session.
  if (next.spaceName && next.identity && !next.session) {
    next.session = await createSession(
      next.identity,
      next.spaceName,
    );
  }
  return next;
}

async function createSession(
  root: Identity,
  spaceName: string,
): Promise<Session> {
  const account = spaceName.startsWith("~")
    ? root
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(spaceName);
  return {
    private: account.did() === root.did(),
    name: spaceName,
    space: user.did(),
    as: user,
  };
}
