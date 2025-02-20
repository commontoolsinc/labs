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
  passkeyRegister: (name: string, displayName: string) => Promise<void>;
  // Authenticate the user via passkey.
  passkeyAuthenticate: () => Promise<void>;
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

// (async) open a key store
// (async) check to see key exists
export const AuthenticationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [keyStore, setKeyStore] = useState<KeyStore | void>(undefined);
  const [user, setUser] = useState<Identity | void>(undefined);
  const [root, setRoot] = useState<Identity | void>(undefined);

  // On load, open the KeyStore and find a root key.
  useEffect(() => {
    let ignore = false;
    async function getKeyStoreAndRoot() {
      let keyStore = await KeyStore.open();
      let root = await keyStore.get(ROOT_KEY);
      if (!ignore) {
        setKeyStore(keyStore);
        if (root) {
          setRoot(root);
        }
      }
    }
    getKeyStoreAndRoot(); 
    return () => {
      ignore = true;
      setKeyStore(undefined);
      setRoot(undefined);
    }
  }, []);

  // When root changes, update `user` to the default persona
  useEffect(() => {
    let ignore = false;
    async function setPersona() {
      setUser(undefined);
      if (!root) {
        return;
      }
      let user = await root.derive(DEFAULT_PERSONA);
      if (!ignore) {
        setUser(user);
      }
    }
    setPersona();
    return () => {
      ignore = true;
      setUser(undefined);
    }
  }, [root]);

  // This calls out to WebAuthn to register a user. The state of whether
  // a user has previously registered a passkey is not tracked (and could
  // only be tracked per document), so this doesn't use any hooks.
  //
  // Must be called within a user gesture.
  const passkeyRegister = useCallback(async (name: string, displayName: string) => {
    return PassKey.create(name, displayName);
  }, []);


  // This should be called when a passkey (possibly) exists for the user already,
  // and no root key has yet been stored (e.g. first login). Subsequent page loads
  // should load key from storage and not require this callback.
  //
  // Must be called within a user gesture.
  const passkeyAuthenticate = useCallback(async () => {
    if (!keyStore) {
      return;
    }
    let passkey = await PassKey.get();
    let root = await passkey.createRootKey();
    await keyStore.set(ROOT_KEY, root);
    setRoot(root);
  }, [keyStore]);
 

  const passphraseRegister = useCallback(async () => {
    // Don't store the root identity here. Return only the
    // mnemonic so that the UI can present guidance on handling
    // the private key. The root will be derived from the mnemonic
    // on authentication.
    let [_, mnemonic] = await Identity.generateMnemonic();
    return mnemonic;
  }, []);

  const passphraseAuthenticate = useCallback(async (mnemonic: string) => {
    if (!keyStore) {
      return;
    }
    let root = await Identity.fromMnemonic(mnemonic);
    await keyStore.set(ROOT_KEY, root);
    setRoot(root);
  }, [keyStore]);
  
  const clearAuthentication = useCallback(async () => {
    if (!keyStore) {
      return;
    }
    await keyStore.clear();
    setRoot(undefined);
    setUser(undefined);
  }, [keyStore]);

  return (
    <AuthenticationContext.Provider value={{
      user,
      passkeyAuthenticate,
      passkeyRegister,
      passphraseAuthenticate,
      passphraseRegister,
      clearAuthentication,
      root,
      keyStore,
    }}>
      {children}
    </AuthenticationContext.Provider>
  );
};

export const useAuthentication = () => useContext(AuthenticationContext);
