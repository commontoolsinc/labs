import { useAuthentication } from "@/contexts/AuthenticationContext";
import { useEffect, useState } from "react";

export function User() {
  const { user, clearAuthentication } = useAuthentication();
  const [did, setDid] = useState<string | undefined>(undefined);
  
  useEffect(() => {
    let ignore = false;
    function setDidInner() {
      if (!user) {
        return;
      }
      let did = user.verifier().did();
      if (!ignore) {
        setDid(did);
      }
    }
    setDidInner();
    return () => {
      setDid(undefined);
      ignore = true;
    }
  }, [user]);

  let h = "0";
  let s = "50%";
  let l = "50%";

  if (did) {
    let index = did.length - 4;
    // DID string is `did:key:z{REST}`. Taking the last 3 characters,
    // we use the first two added for hue.
    h = `${did.charCodeAt(index) + did.charCodeAt(index + 1)}`;
    // Then the final character for saturation, map ASCII codes 49-122 to saturation 50%-100%
    s = `${(50 + (((did.charCodeAt(index + 2) - 49) / 73) * 50))}%`;
  }

  const styles = {
    width: "30px",
    height: "30px",
    backgroundColor: `hsl(${h}, ${s}, ${l})`,
  };
  return (
    <div
      onClick={clearAuthentication}
      title={did ?? "undefined"}
      style={styles}
      className="relative flex max-w-xs items-center rounded-full bg-gray-800 text-sm focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-gray-800 focus:outline-hidden">
    </div>
  );
}
