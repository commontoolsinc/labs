import React, { useMemo, useRef } from "react";
import { render, type VNode } from "@commontools/html";
import { UI } from "@commontools/builder";
import { charmId, charmSchema, fixItCharm } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useNavigate } from "react-router-dom";
import { LuX } from "react-icons/lu";
import { DitheredCube } from "@/components/DitherCube.tsx";
import { createPath } from "@/routes.ts";
import { Cell, Charm } from "@/utils/charms.ts";
import { notify } from "@/contexts/ActivityContext.tsx";

interface CharmLoaderProps {
  charmImport: () => Promise<any>;
  argument?: any;
  autoLoad?: boolean;
  onCharmReady: (charm: any) => void;
}

interface CharmRendererProps {
  charm: Cell<Charm>;
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
  const { charmManager, currentReplica } = useCharmManager();

  const onCharmReadyCallback = React.useCallback(onCharmReady, [onCharmReady]);

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

      onCharmReadyCallback(charm);
    } catch (err) {
      if (currentMountKey === mountingKey.current) {
        setError(err as Error);
      }
    } finally {
      if (currentMountKey === mountingKey.current) {
        setIsLoading(false);
      }
    }
  }, [charmImport, argument, onCharmReadyCallback, charmManager]);

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

function RawCharmRenderer({ charm, className = "" }: CharmRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [runtimeError, setRuntimeError] = React.useState<Error | null>(null);
  const [isFixing, setIsFixing] = React.useState(false);
  const { charmManager, currentReplica } = useCharmManager();
  const id = useMemo(() => charmId(charm), [charm]);
  const navigate = useNavigate();

  // Store a reference to the current charm to detect changes
  const prevCharmRef = useRef<Charm | null>(null);

  // Clear error when charm changes
  React.useEffect(() => {
    if (prevCharmRef.current !== charm) {
      setRuntimeError(null);
      prevCharmRef.current = charm;
    }
  }, [id]);

  const handleFixIt = React.useCallback(async () => {
    if (!runtimeError || isFixing) return;
    setIsFixing(true);
    try {
      const newCharm = await fixItCharm(charmManager, charm, runtimeError);
      setRuntimeError(null);
      navigate(
        createPath("charmShow", {
          charmId: charmId(newCharm)!,
          replicaName: currentReplica,
        }),
      );
    } catch (error) {
      console.error("Fix it error:", error);
    } finally {
      setIsFixing(false);
    }
  }, [runtimeError, isFixing, charmManager, id, currentReplica, navigate]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Clear any previous errors when mounting a new charm
    setRuntimeError(null);

    function handleIframeError(event: Event) {
      const customEvent = event as CustomEvent<Error>;
      notify("Charm Error!", customEvent.detail.message, "error");
      setRuntimeError(customEvent.detail);
    }

    container.addEventListener("common-iframe-error", handleIframeError);

    console.log("LLMTRACE", charmManager.getLLMTrace(charm));

    const cleanup = render(
      container,
      charm.asSchema(charmSchema).key(UI) as Cell<VNode>,
    );

    return () => {
      cleanup();
      if (container) {
        container.removeEventListener("common-iframe-error", handleIframeError);
        container.innerHTML = "";
      }
    };
  }, [id]);

  return (
    // @ts-ignore Ignore typechecking for custom element.
    <common-charm charm-id={charmId(charm)} space-name={currentReplica}>
      {runtimeError
        ? (
          <div className="bg-red-500 text-white p-4">
            <div className="flex items-start justify-between gap-4">
              <pre title={runtimeError.stack} className="overflow-auto flex-1">
              {runtimeError.stack}
              </pre>
              <div className="flex gap-2 shrink-0">
                <button
                  type="button"
                  onClick={handleFixIt}
                  disabled={isFixing}
                  className="px-2 py-1 bg-white text-red-500 rounded text-sm hover:bg-red-50 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap"
                >
                  {isFixing && (
                    <DitheredCube
                      animationSpeed={2}
                      width={16}
                      height={16}
                      animate
                      cameraZoom={12}
                    />
                  )}
                  {isFixing ? "Fixing..." : "Fix It"}
                </button>
                <button
                  type="button"
                  className="hover:opacity-75"
                  onClick={() => setRuntimeError(null)}
                >
                  <LuX className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )
        : null}
      <div
        className={className}
        ref={containerRef}
        aria-label="charm-content"
      >
      </div>
      {/* @ts-ignore Ignore typechecking for custom element. */}
    </common-charm>
  );
}

export const CharmRenderer = React.memo(RawCharmRenderer);

function RawCharmRunner(
  props: CharmLoaderProps & Omit<CharmRendererProps, "charm">,
) {
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

export const CharmRunner = React.memo(RawCharmRunner);
