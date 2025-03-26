import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { DID, Identity, KeyStore, PassKey } from "@commontools/identity";
import { matchSpace } from "@/routes.ts";
import { sleep } from "@commontools/utils/sleep";

// Location in storage of root key.
const ROOT_KEY = "$ROOT_KEY";

export const ANYONE = "common user";

/**
 * Representation authorization session.
 */
export interface Session {
  /**
   * Whether session is for a private space vs public access space.
   */
  private: boolean;

  /**
   * Session name, which is pet name of the space session is for.
   */
  name: string;

  /**
   * DID identifier of the space this is a session for.
   */
  space: DID;

  /**
   * Identity used in this session.
   */
  as: Identity;
}

interface AuthenticationContextType {
  // Active authorization session
  session: Session | void;
  // Call PassKey registration.
  passkeyRegister: (name: string, displayName: string) => Promise<PassKey>;
  // Authenticate the user via passkey.
  passkeyAuthenticate: (
    descriptor?: PublicKeyCredentialDescriptor,
  ) => Promise<PassKey>;
  // Generate a passphrase for a new user
  passphraseRegister: () => Promise<string>;
  // Authenticate via passphrase.
  passphraseAuthenticate: (mnemonic: string) => Promise<void>;
  // Clears authentication database.
  clearAuthentication: () => Promise<void>;
  // Internal: Root key.
  root: Identity | void;
  // Internal: Persistent storage for keys.
  keyStore: KeyStore | void;
}

const AuthenticationContext = createContext<AuthenticationContextType>(null!);

export const AuthenticationProvider: React.FC<{ children: React.ReactNode }> = (
  { children },
) => {
  const [keyStore, setKeyStore] = useState<KeyStore | void>(undefined);
  const [session, setSession] = useState<Session | void>(undefined);
  const [root, setRoot] = useState<Identity | void>(undefined);

  const { replicaName: spaceName } = matchSpace(location.pathname);

  // On load, open the KeyStore and find a root key.
  useEffect(() => {
    let ignore = false;
    async function getKeyStoreAndRoot() {
      // There is some issue in CI where we wait on `KeyStore.open`
      // indefinitely. Possibly on load, the indexedDB request is queued
      // behind some startup processing. Waiting alleviates this issue.
      await sleep(100);

      const keyStore = await KeyStore.open();
      const root = await keyStore.get(ROOT_KEY);
      if (!ignore) {
        setKeyStore(keyStore);
        setRoot(root);
      }
    }
    getKeyStoreAndRoot();

    return () => {
      ignore = true;
      setKeyStore(undefined);
      setRoot(undefined);
    };
  }, []);

  // When root changes, update `user` to the default persona
  useEffect(() => {
    let ignore = false;

    async function setPersona() {
      setSession(undefined);
      if (!root || !spaceName) {
        return;
      }

      const account = isPrivateSpace(spaceName)
        ? root
        : await Identity.fromPassphrase(ANYONE);

      const user = await account.derive(spaceName);

      if (!ignore) {
        setSession({
          private: account.did() === root.did(),
          name: spaceName,
          space: user.did(),
          as: user,
        });
      }
    }
    setPersona();

    return () => {
      ignore = true;
      setSession(undefined);
    };
  }, [root, spaceName]);

  // This calls out to WebAuthn to register a user. The state of whether
  // a user has previously registered a passkey is not tracked (and could
  // only be tracked per document), so this doesn't use any hooks.
  //
  // Must be called within a user gesture.
  const passkeyRegister = useCallback(
    async (name: string, displayName: string) => {
      const credential = await PassKey.create(name, displayName);
      return credential;
    },
    [],
  );

  // This should be called when a passkey (possibly) exists for the user already,
  // and no root key has yet been stored (e.g. first login). Subsequent page loads
  // should load key from storage and not require this callback.
  //
  // Must be called within a user gesture.
  const passkeyAuthenticate = useCallback(
    async (key?: PublicKeyCredentialDescriptor) => {
      if (!keyStore) {
        throw new Error("Key store not initialized");
      }
      // if we can, we prompt directly for the passed credential
      const passkey = await PassKey.get({ allowCredentials: key ? [key] : [] });
      const root = await passkey.createRootKey();
      await keyStore.set(ROOT_KEY, root);
      setRoot(root);
      return passkey;
    },
    [keyStore],
  );

  const passphraseRegister = useCallback(async () => {
    // Don't store the root identity here. Return only the
    // mnemonic so that the UI can present guidance on handling
    // the private key. The root will be derived from the mnemonic
    // on authentication.
    const [, mnemonic] = await Identity.generateMnemonic();
    return mnemonic;
  }, []);

  const passphraseAuthenticate = useCallback(
    async (mnemonic: string) => {
      if (!keyStore) {
        throw new Error("Key store not initialized");
      }
      const root = await Identity.fromMnemonic(mnemonic);
      await keyStore.set(ROOT_KEY, root);
      setRoot(root);
    },
    [keyStore],
  );

  const clearAuthentication = useCallback(async () => {
    if (!keyStore) {
      return;
    }
    await keyStore.clear();
    setRoot(undefined);
    setSession(undefined);
  }, [keyStore]);

  return (
    <AuthenticationContext.Provider
      value={{
        session,
        passkeyAuthenticate,
        passkeyRegister,
        passphraseAuthenticate,
        passphraseRegister,
        clearAuthentication,
        root,
        keyStore,
      }}
    >
      {children}
    </AuthenticationContext.Provider>
  );
};

const isPrivateSpace = (name: string) => name.startsWith("~");

export const useAuthentication = () => useContext(AuthenticationContext);
