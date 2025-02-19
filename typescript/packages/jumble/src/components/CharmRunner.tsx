import React, { useRef } from "react";
import { render } from "@commontools/html";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useNavigate } from "react-router-dom";

interface CharmLoaderProps {
  charmImport: () => Promise<any>;
  argument?: any;
  autoLoad?: boolean;
  onCharmReady: (charm: any) => void;
}

interface CharmRendererProps {
  charm: any;
  argument?: any;
  className?: string;
}

function useCharmLoader({
  charmImport,
  argument,
  autoLoad = false,
  onCharmReady,
}: CharmLoaderProps) {
  const [error, setError] = React.useState<Error | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const mountingKey = useRef(0);
  const { charmManager } = useCharmManager();

  const loadCharm = React.useCallback(async () => {
    const currentMountKey = ++mountingKey.current;
    setIsLoading(true);
    setError(null);

    try {
      const module = await charmImport();
      const factory = module.default;

      if (!factory) {
        throw new Error("Invalid charm module: missing default export");
      }

      if (currentMountKey !== mountingKey.current) return;

      const charm = await charmManager.runPersistent(factory, argument);
      if (currentMountKey !== mountingKey.current) return;

      charmManager.add([charm]);

      if (currentMountKey !== mountingKey.current) return;

      onCharmReady(charm);
    } catch (err) {
      if (currentMountKey === mountingKey.current) {
        setError(err as Error);
      }
    } finally {
      if (currentMountKey === mountingKey.current) {
        setIsLoading(false);
      }
    }
  }, [charmImport, argument, onCharmReady, charmManager]);

  React.useEffect(() => {
    if (autoLoad) {
      loadCharm();
    }
    return () => {
      mountingKey.current++;
    };
  }, [autoLoad, loadCharm]);

  return { error, isLoading };
}

export function CharmRenderer({ charm, className = "" }: CharmRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [runtimeError, setRuntimeError] = React.useState<Error | null>(null);
  const { charmManager, currentReplica, fixIt } = useCharmManager();
  const navigate = useNavigate();

  const handleFixIt = async () => {
    if (!runtimeError) return;
    try {
      const newPath = await fixIt({
        charm,
        error: runtimeError,
        charmManager,
        replicaId: currentReplica,
      });
      if (newPath) {
        navigate(`/${currentReplica}/${newPath}`);
      }
    } catch (error) {
      console.error("Fix it error:", error);
    }
  };

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    function handleIframeError(event: Event) {
      const customEvent = event as CustomEvent<Error>;
      setRuntimeError(customEvent.detail);
    }

    container.addEventListener("common-iframe-error", handleIframeError);

    const cleanup = render(container, charm.asCell().key("$UI"));

    return () => {
      cleanup();
      if (container) {
        container.removeEventListener("common-iframe-error", handleIframeError);
        container.innerHTML = "";
      }
    };
  }, [charm]);

  return (
    <>
      {runtimeError ? (
        <div className="bg-red-500 text-white p-4">
          <div className="flex justify-between items-center mb-2">
            <button className="hover:opacity-75" onClick={() => setRuntimeError(null)}>
              ✖️
            </button>
            <button
              onClick={handleFixIt}
              className="px-2 py-1 bg-white text-red-500 rounded text-sm hover:bg-red-50"
            >
              Fix It
            </button>
          </div>
          <pre title={runtimeError.stack}>{runtimeError.message}</pre>
        </div>
      ) : null}
      <div className={className} ref={containerRef}></div>
    </>
  );
}

export function CharmRunner(props: CharmLoaderProps & Omit<CharmRendererProps, "charm">) {
  const [charm, setCharm] = React.useState<any>(null);
  const { error, isLoading } = useCharmLoader({
    ...props,
    onCharmReady: setCharm,
  });

  return (
    <>
      {isLoading && <div>Loading...</div>}
      {error && <div>Error loading charm</div>}
      {charm && <CharmRenderer charm={charm} className={props.className} />}
    </>
  );
}
