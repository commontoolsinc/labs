import {
  ANYONE,
  DID,
  Identity,
  KeyStore,
  PassKey,
} from "@commontools/identity";
import { Command } from "../commands.ts";
import { createPasskeyCredential, saveCredential } from "../credentials.ts";

// Representation of authorization session.
export interface Session {
  // Whether session is for a private space vs public access space.
  private: boolean;
  // Session name, which is pet name of the space session is for.
  name: string;
  // DID identifier of the space this is a session for.
  space: DID;
  // Identity used in this session.
  as: Identity;
}

// Primary application state.
export interface AppState {
  identity?: Identity;
  spaceName?: string;
  activeCharmId?: string;
  apiUrl: URL;
  keyStore?: KeyStore;
  session?: Session;
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state);
}

// Key store key name for user's key
export const ROOT_KEY = "$ROOT_KEY";

export async function applyCommand(
  state: AppState,
  command: Command,
): Promise<AppState> {
  const next = clone(state);
  switch (command.type) {
    case "set-active-charm-id": {
      next.activeCharmId = command.charmId;
      break;
    }
    case "set-identity": {
      next.identity = command.identity;
      break;
    }
    case "set-space": {
      next.spaceName = command.spaceName;
      break;
    }
    case "set-keystore": {
      next.keyStore = command.keyStore;
      break;
    }
    case "set-session": {
      next.session = command.session;
      break;
    }
    case "passkey-register": {
      const { name, displayName } = command;
      const passkey = await PassKey.create(name, displayName);
      const root = await passkey.createRootKey();
      if (state.keyStore) {
        await state.keyStore.set(ROOT_KEY, root);
      }
      next.identity = root;
      break;
    }
    case "passkey-authenticate": {
      const { descriptor } = command;
      const passkey = await PassKey.get({
        allowCredentials: descriptor ? [descriptor] : [],
      });
      const root = await passkey.createRootKey();
      if (state.keyStore) {
        await state.keyStore.set(ROOT_KEY, root);
      }
      next.identity = root;

      // Store credential info for future logins
      const credential = createPasskeyCredential(passkey.id());
      saveCredential(credential);
      break;
    }
    case "passphrase-register": {
      // Generate mnemonic but don't store identity yet - let user save it first
      const [, mnemonic] = await Identity.generateMnemonic();
      // Store the mnemonic temporarily in the state so the UI can access it
      (next as any).__tempMnemonic = mnemonic;
      break;
    }
    case "passphrase-display-mnemonic": {
      // This command is just for tracking - the mnemonic is already in the UI
      break;
    }
    case "passphrase-authenticate": {
      const { mnemonic } = command;
      const root = await Identity.fromMnemonic(mnemonic);
      if (state.keyStore) {
        await state.keyStore.set(ROOT_KEY, root);
      }
      next.identity = root;
      break;
    }
    case "clear-authentication": {
      if (state.keyStore) {
        await state.keyStore.clear();
      }
      next.identity = undefined;
      next.session = undefined;
      break;
    }
  }

  // Update session when identity or space changes
  if (
    (next.identity !== state.identity || next.spaceName !== state.spaceName) &&
    next.identity && next.spaceName
  ) {
    const isPrivateSpace = next.spaceName.startsWith("~");
    const account = isPrivateSpace
      ? next.identity
      : await Identity.fromPassphrase(ANYONE);
    const user = await account.derive(next.spaceName);

    next.session = {
      private: isPrivateSpace,
      name: next.spaceName,
      space: user.did(),
      as: user,
    };
  }

  return next;
}
