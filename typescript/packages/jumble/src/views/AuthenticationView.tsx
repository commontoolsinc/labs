import { useAuthentication } from "@/contexts/AuthenticationContext";
import { useCallback, useRef, useState } from "react";

const BTN_STYLE=`bg-gray-50 border-2 p-2 w-full flex-1 cursor-pointer`;
const PW_STYLE=`bg-gray-50 border-2 p-2 w-full flex-1`;

export function AuthenticationView() {
  const { user, passkeyRegister, passkeyAuthenticate, passphraseRegister, passphraseAuthenticate } = useAuthentication();
  if (user) {
    throw new Error("Displaying authentication view when already authenticated.");
  }
  const [mnemonic, setMnemonic] = useState<string>("");
  const passphraseInput = useRef(null);


  const createMnemonic = useCallback(async () => {
    setMnemonic(await passphraseRegister());
  }, []);

  const authWithMnemonicInput = useCallback(async () => {
    if (passphraseInput.current == null) { return; }
    let passphrase = (passphraseInput.current as HTMLInputElement).value;
    await passphraseAuthenticate(passphrase);
    setMnemonic("");
  }, [passphraseInput]);

  const authWithMnemonicState = useCallback(async () => {
    let passphrase = mnemonic;
    setMnemonic("");
    await passphraseAuthenticate(passphrase);
  }, [mnemonic]);

  if (mnemonic) {
    return (
      <div className="flex flex-col">
      <div className="flex flex-col bg-gray-50 items-center justify-between border-2 p-2 m-2 flex-1"> 
        <h3>Your Secret Recovery Key</h3>
        <textarea
          readOnly={true}
          value={mnemonic}
          className="block w-full rounded-md bg-white px-3 py-1.5">
        </textarea>
        <button className={BTN_STYLE} onClick={authWithMnemonicState}>OK</button>
      </div>
      </div>
    )
  }
  return (
    <div className="flex flex-row">
      <div className="flex flex-col bg-gray-50 items-center justify-between border-2 p-2 m-2 flex-1"> 
        <h3>via Passkey</h3>
        <button className={BTN_STYLE} onClick={() => passkeyRegister("Common Tools User", "commontoolsuser")}>Register</button>
        <button className={BTN_STYLE} onClick={passkeyAuthenticate}>Login</button>
      </div>
      <div className="flex flex-col bg-gray-50 items-center justify-between border-2 p-2 m-2 flex-1">
        <h3>via Passphrase</h3>
        <button className={BTN_STYLE} onClick={createMnemonic}>Register</button>
        <button className={BTN_STYLE} onClick={authWithMnemonicInput}>Login</button>
        <input className={PW_STYLE} type="password" placeholder="passphrase" ref={passphraseInput}></input>
      </div>
    </div>
  );
}
