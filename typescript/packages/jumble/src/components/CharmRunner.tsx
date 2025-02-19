import React, { useRef } from "react";
import { render } from "@commontools/html";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { useNavigate } from "react-router-dom";
import { fixItCharm } from "@/utils/charm-operations";
import { LuX } from "react-icons/lu";
import { DitheredCube } from "@/components/DitherCube";

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
  const [isFixing, setIsFixing] = React.useState(false);
  const { charmManager, currentReplica } = useCharmManager();
  const navigate = useNavigate();

  const handleFixIt = async () => {
    if (!runtimeError || isFixing) return;
    setIsFixing(true);
    try {
      const newPath = await fixItCharm(charmManager, charm, runtimeError);
      if (newPath) {
        setRuntimeError(null); // clear the error
        navigate(`/${currentReplica}/${newPath}`); // navigate to the new charm
      }
    } catch (error) {
      console.error("Fix it error:", error);
    } finally {
      setIsFixing(false);
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
          <div className="flex items-start justify-between gap-4">
            <pre title={runtimeError.stack} className="overflow-auto flex-1">
              {runtimeError.stack}
            </pre>
            <div className="flex gap-2 shrink-0">
              <button
                onClick={handleFixIt}
                disabled={isFixing}
                className="px-2 py-1 bg-white text-red-500 rounded text-sm hover:bg-red-50 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
              >
                {isFixing && (
                  <DitheredCube
                    animationSpeed={2}
                    width={16}
                    height={16}
                    animate={true}
                    cameraZoom={12}
                  />
                )}
                {isFixing ? "Fixing..." : "Fix It"}
              </button>
              <button className="hover:opacity-75" onClick={() => setRuntimeError(null)}>
                <LuX className="w-4 h-4" />
              </button>
            </div>
          </div>
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
