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

const BTN_PRIMARY = `w-full px-4 py-2 bg-black text-white hover:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2`;
const LIST_ITEM = `w-full p-2 text-left text-sm border-2 border-black hover:-translate-y-[2px] hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,0.5)] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.3)] transition-all duration-100 ease-in-out cursor-pointer flex items-center gap-2`;
const INPUT_STYLE = `w-full p-2 border rounded`;

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
}

interface StoredCredential {
  id: string;
  type: "public-key" | "passphrase";
  method: AuthMethod;
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
function SuccessRegistration({ mnemonic, onLogin, method }: SuccessRegistrationProps) {
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
      {mnemonic && (
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
  const [availableMethods, setAvailableMethods] = useState<AuthMethod[]>([]);
  const [storedCredential, setStoredCredential] = useState<StoredCredential | null>(() => {
    const stored = localStorage.getItem("storedCredential");
    return stored ? JSON.parse(stored) : null;
  });

  useEffect(() => {
    const methods: AuthMethod[] = ["passphrase"]; // Passphrase always available

    // Add passkey if available
    const isPasskeyAvailable =
      window.location.hostname !== "localhost" && window.PublicKeyCredential !== undefined;

    if (isPasskeyAvailable) {
      methods.push("passkey");
    }

    setAvailableMethods(methods);
    // Only set default method if there's just one option
    if (methods.length === 1) {
      setMethod(methods[0]);
    }
  }, []);

  async function handleAuth<T>(action: () => Promise<T>) {
    try {
      setError(null);
      return await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authentication failed");
      // Reset both flow and method to return to initial state
      setFlow(null);
      setMethod(null);
    }
  }

  const handleRegister = useCallback(
    async (selectedMethod: string) => {
      if (selectedMethod === "passkey") {
        const credential = await handleAuth(() =>
          auth.passkeyRegister("Common Tools User", "commontoolsuser"),
        );
        if (!credential) throw new Error("Credential not found");

        const storedCred: StoredCredential = {
          id: credential.id,
          type: "public-key",
          method: "passkey",
        };
        localStorage.setItem("storedCredential", JSON.stringify(storedCred));
      } else {
        const mnemonic = await auth.passphraseRegister();
        // Store passphrase credential info
        const storedCred: StoredCredential = {
          id: crypto.randomUUID(), // Generate a unique ID for the passphrase credential
          type: "passphrase",
          method: "passphrase",
        };
        localStorage.setItem("storedCredential", JSON.stringify(storedCred));
        setMnemonic(mnemonic);
      }
    },
    [handleAuth, auth],
  );

  const handleLogin = useCallback(
    async (selectedMethod: string, passphrase?: string) => {
      if (selectedMethod === "passkey") {
        if (storedCredential && storedCredential.type == "public-key") {
          const credentialDescriptor: PublicKeyCredentialDescriptor = {
            id: Uint8Array.from(atob(storedCredential.id), (c) => c.charCodeAt(0)),
            type: storedCredential.type,
          };
          await handleAuth(() => auth.passkeyAuthenticate(credentialDescriptor));
        } else {
          await handleAuth(() => auth.passkeyAuthenticate());
        }
      } else if (passphrase) {
        await handleAuth(() => auth.passphraseAuthenticate(passphrase));
      }
    },
    [storedCredential, handleAuth, auth],
  );

  const handleMethodSelect = useCallback(
    async (selectedMethod: AuthMethod) => {
      debugger;
      setMethod(selectedMethod);
      if (flow === "register") {
        await handleRegister(selectedMethod);
      } else {
        await handleLogin(selectedMethod);
      }
    },
    [flow, setMethod, handleRegister, handleLogin],
  );

  const clearStoredCredential = useCallback(() => {
    localStorage.removeItem("storedCredential");
    setStoredCredential(null);
  }, []);

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

        {mnemonic ? (
          <SuccessRegistration
            mnemonic={mnemonic}
            method={method!}
            onLogin={() => {
              setMnemonic(null);
              setFlow("login");
            }}
          />
        ) : flow === null ? (
          <div className="space-y-4">
            {storedCredential ? (
              <>
                <button
                  className={BTN_PRIMARY}
                  onClick={() => {
                    setMethod(storedCredential.method);
                    setFlow("login");
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
                <button className={LIST_ITEM} onClick={clearStoredCredential}>
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
              <button key={m} className={LIST_ITEM} onClick={() => handleMethodSelect(m)}>
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
              <button className={BTN_PRIMARY} onClick={handleRegister}>
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
