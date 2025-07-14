import {
  ANYONE,
  Identity,
  KeyStore,
  PassKey,
} from "@commontools/identity";
import { AppState, ROOT_KEY, Session } from "./app/state.ts";
import { createPasskeyCredential, saveCredential } from "./credentials.ts";

export async function handlePasskeyRegister(
  state: AppState,
  name: string,
  displayName: string,
): Promise<Identity> {
  const passkey = await PassKey.create(name, displayName);
  const root = await passkey.createRootKey();
  
  if (state.keyStore) {
    await state.keyStore.set(ROOT_KEY, root);
  }
  
  return root;
}

export async function handlePasskeyAuthenticate(
  state: AppState,
  descriptor?: PublicKeyCredentialDescriptor,
): Promise<Identity> {
  const passkey = await PassKey.get({
    allowCredentials: descriptor ? [descriptor] : [],
  });
  const root = await passkey.createRootKey();
  
  if (state.keyStore) {
    await state.keyStore.set(ROOT_KEY, root);
  }
  
  // Store credential info for future logins
  const credential = createPasskeyCredential(passkey.id());
  saveCredential(credential);
  
  return root;
}

export async function handlePassphraseAuthenticate(
  state: AppState,
  mnemonic: string,
): Promise<Identity> {
  const root = await Identity.fromMnemonic(mnemonic);
  
  if (state.keyStore) {
    await state.keyStore.set(ROOT_KEY, root);
  }
  
  return root;
}

export async function handleClearAuthentication(
  keyStore?: KeyStore,
): Promise<void> {
  if (keyStore) {
    await keyStore.clear();
  }
}

export async function createSessionForIdentity(
  identity: Identity,
  spaceName: string,
): Promise<Session> {
  const isPrivateSpace = spaceName.startsWith("~");
  const account = isPrivateSpace
    ? identity
    : await Identity.fromPassphrase(ANYONE);
  const user = await account.derive(spaceName);

  return {
    private: isPrivateSpace,
    name: spaceName,
    space: user.did(),
    as: user,
  };
}