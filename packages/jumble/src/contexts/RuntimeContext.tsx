import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Runtime } from "@commontools/runner";
import {
  defaultSettings,
  StorageManager,
} from "@commontools/runner/storage/cache";
import { useAuthentication } from "./AuthenticationContext.tsx";
import { navigateToCharm } from "@/utils/navigation.ts";
import { setupIframe } from "@/iframe-ctx.ts";
import * as Sentry from "@sentry/react";
interface RuntimeContextType {
  runtime: Runtime | undefined;
}

const RuntimeContext = createContext<RuntimeContextType | undefined>(undefined);

export function RuntimeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { session } = useAuthentication();
  const [runtime, setRuntime] = useState<Runtime | undefined>(undefined);

  // Get DID from session
  useEffect(() => {
    if (!session) return;
    // Create runtime with error and console handlers
    let errorCount = 0;
    const queryMode = (import.meta as any).env?.VITE_STORAGE_TYPE ?? "schema";
    // Default to "schema", but let either custom URL (used in tests) or
    // environment variable override this.
    const runtime = new Runtime({
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", location.origin),
        settings: {
          ...defaultSettings,
          // Default to "schema", but let either custom URL (used in tests) or
          // environment variable override this.
          useSchemaQueries: queryMode === "schema" ? true : false,
        },
      }),
      blobbyServerUrl: location.origin,
      errorHandlers: [(error) => {
        if (!errorCount++) {
          alert(
            "Uncaught error in recipe: " + error.message + "\n" + error.stack,
          );
        }
        console.error(error);
        // Also send to Sentry
        Sentry.captureException(error);
      }],
      consoleHandler: (metadata, method, args) => {
        // Handle console messages depending on charm context.
        // This is essentially the same as the default handling currently,
        // but adding this here for future use.
        if (metadata?.charmId) {
          return [`Charm(${metadata.charmId}) [${method}]:`, ...args];
        }
        return [`Console [${method}]:`, ...args];
      },
      navigateCallback: (target) => navigateToCharm(target),
    });

    setupIframe(runtime);
    setRuntime(runtime);
    return () => setRuntime(undefined);
  }, [session]);

  // Only render children if we have a runtime
  return (
    <RuntimeContext.Provider value={{ runtime }}>
      {runtime ? children : []}
    </RuntimeContext.Provider>
  );
}

export function useRuntime(): Runtime {
  const runtime = useContext(RuntimeContext)?.runtime;
  if (!runtime) {
    throw new Error("useRuntime must be used within a RuntimeProvider");
  }
  return runtime;
}
