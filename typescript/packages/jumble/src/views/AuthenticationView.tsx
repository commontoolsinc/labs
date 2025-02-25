import { useAuthentication } from "@/contexts/AuthenticationContext.tsx";
import { useCallback, useRef, useState } from "react";
import ShapeLogo from "@/assets/ShapeLogo.svg";
import { useAuthentication } from "@/contexts/AuthenticationContext";
import { useCallback, useEffect, useState } from "react";
import {
  LuArrowLeft,
  LuKey,
  LuKeyRound,
  LuCirclePlus,
  LuLock,
  LuTextCursorInput,
  LuCopy,
  LuTrash2,
  LuCheck,
} from "react-icons/lu";
import {
  type StoredCredential,
  getStoredCredential,
  saveCredential,
  clearStoredCredential,
  createPasskeyCredential,
  createPassphraseCredential,
  getPublicKeyCredentialDescriptor,
} from "@/utils/credentials";

const BTN_PRIMARY = `w-full px-4 py-2 bg-black text-white hover:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2`;
const LIST_ITEM = `w-full p-2 text-left text-sm border-2 border-black hover:-translate-y-[2px] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.3)] transition-all duration-100 ease-in-out cursor-pointer flex items-center gap-2`;

type AuthMethod = "passkey" | "passphrase";
type AuthFlow = "register" | "login";

interface ErrorCalloutProps {
  error: string;
  onDismiss: () => void;
}

interface SuccessRegistrationProps {
  mnemonic?: string;
  onLogin: () => void;
  method: AuthMethod;
  credentialId?: string;
}

function ErrorCallout({ error, onDismiss }: ErrorCalloutProps) {
  return (
    <div className="bg-red-50 border-l-4 border-red-400 p-4 mb-4">
      <div className="flex">
        <div className="flex-1">{error}</div>
        <button onClick={onDismiss}>×</button>
      </div>
    </div>
  );
}

function SuccessRegistration({
  mnemonic,
  onLogin,
  method,
  credentialId,
}: SuccessRegistrationProps) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    if (mnemonic) {
      navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 750);
    }
  };

  return (
    <div className="text-center">
      {method === "passkey" ? (
        <div className="mb-4">
          <p className="mb-2">Passkey successfully registered!</p>
          {credentialId && (
            <p className="text-sm text-gray-500 mt-2">Key ID: ...{credentialId.slice(-4)}</p>
          )}
        </div>
      ) : (
        mnemonic && (
          <div className="mb-4">
            <p className="mb-2">Your Secret Recovery Phrase:</p>
            <div className="relative">
              <textarea
                readOnly
                value={mnemonic}
                rows={3}
                className="w-full p-2 pr-10 border-2 border-black resize-none"
              />
              <button
                onClick={copyToClipboard}
                className={`absolute right-2 top-1/2 transform -translate-y-1/2 ${
                  copied ? "text-green-500" : ""
                }`}
              >
                {copied ? <LuCheck className="w-5 h-5" /> : <LuCopy className="w-5 h-5" />}
              </button>
            </div>
            <p className="text-sm text-gray-500 mt-2">
              Please save this phrase securely. You'll need it to log in.
            </p>
          </div>
        )
      )}
      <button className={BTN_PRIMARY} onClick={onLogin}>
        <LuLock className="w-5 h-5" /> Continue to Login
      </button>
    </div>
  );
}

export function AuthenticationView() {
  const auth = useAuthentication();
  const [flow, setFlow] = useState<AuthFlow | null>(null);
  const [method, setMethod] = useState<AuthMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);
  const [availableMethods, setAvailableMethods] = useState<AuthMethod[]>([]);
  const [storedCredential, setStoredCredential] = useState<StoredCredential | null>(() =>
    getStoredCredential(),
  );

  useEffect(() => {
    const methods: AuthMethod[] = []; // Passphrase always available
    // Add passkey if available
    const isPasskeyAvailable =
      window.location.hostname !== "localhost" && window.PublicKeyCredential !== undefined;

    if (isPasskeyAvailable) {
      methods.push("passkey");
    }

    methods.push("passphrase");

    setAvailableMethods(methods);
    // Only set default method if there's just one option
    if (methods.length === 1) {
      setMethod(methods[0]);
    }
  }, []);

  const handleAuth = useCallback(async <T,>(action: () => Promise<T>) => {
    try {
      setError(null);
      setIsProcessing(true);
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
      // Reset both flow and method to return to initial state
      setFlow(null);
      setMethod(null);
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const handleRegister = useCallback(
    async (selectedMethod: string) => {
      if (selectedMethod === "passkey") {
        const credential = await handleAuth(() =>
          auth.passkeyRegister("Common Tools User", "commontoolsuser"),
        );
        if (!credential) throw new Error("Credential not found");
        setMethod("passkey");
        setRegistrationSuccess(true);
      } else {
        const mnemonic = await auth.passphraseRegister();
        setMnemonic(mnemonic);
      }
    },
    [handleAuth, auth],
  );

  const handleLogin = useCallback(
    async (selectedMethod: string, passphrase?: string) => {
      if (selectedMethod === "passkey") {
        const credentialDescriptor = getPublicKeyCredentialDescriptor(storedCredential);

        await handleAuth(async () => {
          setMethod("passkey");
          setFlow("login");
          const passkey = await auth.passkeyAuthenticate(credentialDescriptor);

          // Store credentials before completing authentication
          if (!storedCredential) {
            // Only store if we don't already have one
            const storedCred = createPasskeyCredential(passkey.id());
            saveCredential(storedCred);
            setStoredCredential(storedCred);
            // Add a small delay to ensure the UI updates
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          return passkey;
        });
      } else if (passphrase) {
        await handleAuth(async () => {
          await auth.passphraseAuthenticate(passphrase);

          if (!storedCredential) {
            // Only store if we don't already have one
            const storedCred = createPassphraseCredential();
            saveCredential(storedCred);
            setStoredCredential(storedCred);
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        });
      }
    },
    [storedCredential, handleAuth, auth],
  );

  const handleMethodSelect = useCallback(
    async (selectedMethod: AuthMethod) => {
      setMethod(selectedMethod);
      if (flow === "register") {
        await handleRegister(selectedMethod);
      } else if (flow === "login") {
        if (selectedMethod === "passkey") {
          await handleLogin(selectedMethod); // This login already handles credential storage
        }
        // For passphrase, we'll wait for the form submission
      }
    },
    [flow, handleRegister, handleLogin],
  );

  if (auth.user) {
    throw new Error("Already authenticated");
  }

  return (
    <div>
      <div className="flex justify-center mb-4">
        <ShapeLogo width={128} height={128} shapeColor="#7F08EA" containerColor="#B77EEA" />
      </div>
      <div className="max-w-md mx-auto p-4 bg-white border-2">
        {error && <ErrorCallout error={error} onDismiss={() => setError(null)} />}

        {isProcessing ? (
          <div className="text-center py-4">
            <p>Please follow the browser's prompts to continue...</p>
          </div>
        ) : mnemonic || registrationSuccess ? (
          <SuccessRegistration
            mnemonic={mnemonic || undefined}
            method={method!}
            credentialId={storedCredential?.id}
            onLogin={async () => {
              if (method === "passkey") {
                await handleLogin("passkey");
              } else {
                setMnemonic(null);
                setRegistrationSuccess(false);
                setFlow("login");
              }
            }}
          />
        ) : flow === null ? (
          <div className="space-y-4">
            {storedCredential ? (
              <>
                <button
                  className={BTN_PRIMARY}
                  onClick={async () => {
                    if (storedCredential.method === "passkey") {
                      await handleLogin("passkey");
                    } else {
                      setMethod(storedCredential.method);
                      setFlow("login");
                    }
                  }}
                >
                  <LuKey className="w-5 h-5" />
                  {storedCredential.type === "public-key"
                    ? `Unlock with Key (${storedCredential.id.slice(-4)})`
                    : "Unlock with Passphrase"}
                </button>
                <button className={LIST_ITEM} onClick={() => setFlow("login")}>
                  <LuLock className="w-5 h-5" /> Login with Different Method
                </button>
                <button className={LIST_ITEM} onClick={() => setFlow("register")}>
                  <LuKeyRound className="w-5 h-5" /> Register New Key
                </button>
                <button
                  className={LIST_ITEM}
                  onClick={() => {
                    clearStoredCredential();
                    setStoredCredential(null);
                  }}
                >
                  <LuTrash2 className="w-5 h-5" /> Clear Saved Credentials
                </button>
              </>
            ) : (
              <>
                <button className={BTN_PRIMARY} onClick={() => setFlow("register")}>
                  <LuCirclePlus className="w-5 h-5" /> Register
                </button>
                <button className={BTN_PRIMARY} onClick={() => setFlow("login")}>
                  <LuLock className="w-5 h-5" /> Login
                </button>
              </>
            )}
          </div>
        ) : flow !== null && method === null ? (
          <div className="space-y-4">
            <h2 className="text-xl mb-4">{flow === "login" ? "Login with" : "Register with"}</h2>
            {availableMethods.map((m) => (
              <button
                key={m}
                className={LIST_ITEM}
                onClick={async () => await handleMethodSelect(m)}
              >
                {m === "passkey" ? (
                  <>
                    <LuKey className="w-5 h-5" /> Use Passkey
                  </>
                ) : (
                  <>
                    <LuTextCursorInput className="w-5 h-5" /> Use Passphrase
                  </>
                )}
              </button>
            ))}
            <button className={BTN_PRIMARY} onClick={() => setFlow(null)}>
              <LuArrowLeft className="w-5 h-5" /> Back
            </button>
          </div>
        ) : method === "passphrase" ? (
          <div className="space-y-4">
            {flow === "register" ? (
              <button className={BTN_PRIMARY} onClick={() => handleRegister("passphrase")}>
                <LuKeyRound className="w-5 h-5" /> Register with Passphrase
              </button>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.target as HTMLFormElement;
                  handleLogin(method, new FormData(form).get("passphrase") as string);
                }}
              >
                <input
                  type="password"
                  name="passphrase"
                  className="w-full p-2 pr-10 border-2 border-black"
                  placeholder="Enter your passphrase"
                  autoComplete="current-password"
                />
                <button type="submit" className={BTN_PRIMARY}>
                  <LuLock className="w-5 h-5" /> Login
                </button>
              </form>
            )}
            <button className={BTN_PRIMARY} onClick={() => setFlow(null)}>
              <LuArrowLeft className="w-5 h-5" /> Back
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
