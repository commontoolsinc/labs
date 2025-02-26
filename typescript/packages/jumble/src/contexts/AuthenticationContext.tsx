import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Identity, KeyStore, PassKey } from "@commontools/identity";

// Location in storage of root key.
const ROOT_KEY = "$ROOT_KEY";
// "Name" of default persona derived from root key.
const DEFAULT_PERSONA = "default";

interface AuthenticationContextType {
  // The authenticated user/persona.
  user: Identity | void;
  // Call PassKey registration.
  passkeyRegister: (name: string, displayName: string) => Promise<PassKey>;
  // Authenticate the user via passkey.
  passkeyAuthenticate: (descriptor?: PublicKeyCredentialDescriptor) => Promise<PassKey>;
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

export const AuthenticationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [keyStore, setKeyStore] = useState<KeyStore | void>(undefined);
  const [user, setUser] = useState<Identity | void>(undefined);
  const [root, setRoot] = useState<Identity | void>(undefined);

  // On load, open the KeyStore and find a root key.
  useEffect(() => {
    let ignore = false;
    async function getKeyStoreAndRoot() {
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
      setUser(undefined);
      if (!root) {
        return;
      }
      const user = await root.derive(DEFAULT_PERSONA);
      if (!ignore) {
        setUser(user);
      }
    }
    setPersona();
    return () => {
      ignore = true;
      setUser(undefined);
    };
  }, [root]);

  // This calls out to WebAuthn to register a user. The state of whether
  // a user has previously registered a passkey is not tracked (and could
  // only be tracked per document), so this doesn't use any hooks.
  //
  // Must be called within a user gesture.
  const passkeyRegister = useCallback(async (name: string, displayName: string) => {
    const credential = await PassKey.create(name, displayName);
    return credential;
  }, []);

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
      // Pass the keyName to PassKey.get() if provided
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
        return;
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
    setUser(undefined);
  }, [keyStore]);

  return (
    <AuthenticationContext.Provider
      value={{
        user,
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

export const useAuthentication = () => useContext(AuthenticationContext);
