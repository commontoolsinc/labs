import React, { useRef } from "react";
import { render } from "@commontools/html";
import { CharmManager, Charm } from "@commontools/charm";
import { effect, idle, run } from "@commontools/runner";

interface CharmRunnerProps {
  charmImport: () => Promise<any>;
  argument?: any;
  autoLoad?: boolean;
  className?: string;
}

const charmManager = (() => {
  const urlParams = new URLSearchParams(window.location.search);
  const replica = urlParams.get("replica") ?? undefined;
  const storageType = replica ? "remote" : ((import.meta as any).env.VITE_STORAGE_TYPE ?? "memory");
  return new CharmManager(replica, storageType);
})();


export function CharmRunner({
  charmImport,
  argument,
  autoLoad = false,
  className = "",
}: CharmRunnerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const charmInstance = useRef<any>(null);
  const cleanupFns = useRef<Array<() => void>>([]);
  // Add a mounting key to help us detect remounts
  const mountingKey = useRef(0);

  const cleanup = () => {
    cleanupFns.current.forEach((fn) => fn());
    cleanupFns.current = [];
    if (charmInstance.current) {
      charmInstance.current = null;
    }
    if (containerRef.current) {
      containerRef.current.innerHTML = "";
    }
  };

  const loadAndRunCharm = React.useCallback(async () => {
    if (!containerRef.current) return;

    // Increment mounting key for this attempt
    const currentMountKey = ++mountingKey.current;

    cleanup();
    setIsLoading(true);
    setError(null);

    try {
      const module = await charmImport();
      const factory = module.default;

      if (!factory) {
        throw new Error("Invalid charm module: missing default export");
      }

      // Check if this is still the most recent mounting attempt
      if (currentMountKey !== mountingKey.current) {
        return;
      }

      const charm = await charmManager.runPersistent(factory);

      // Check again after async operation
      if (currentMountKey !== mountingKey.current) {
        return;
      }

      charmManager.add([charm]);

      await idle();
      run(undefined, argument, charm);
      await idle();

      // Final check before setting up effects
      if (currentMountKey !== mountingKey.current) {
        return;
      }

      const cleanupCharm = effect(charm.asCell<Charm>(), (charm) => {
        const cleanupUI = effect(charm["$UI"], (view) => {
          if (containerRef.current) {
            render(containerRef.current, view);
          }
        });
        cleanupFns.current.push(cleanupUI);
      });
      cleanupFns.current.push(cleanupCharm);

      charmInstance.current = charm;
    } catch (err) {
      if (currentMountKey === mountingKey.current) {
        setError(err as Error);
      }
    } finally {
      if (currentMountKey === mountingKey.current) {
        setIsLoading(false);
      }
    }
  }, [charmImport, argument]);

  // Clean up on unmount
  React.useEffect(() => {
    return () => {
      mountingKey.current++;
      cleanup();
    };
  }, []);

  // Handle autoLoad
  React.useEffect(() => {
    if (autoLoad) {
      loadAndRunCharm();
    }
  }, [autoLoad, loadAndRunCharm]);

  // Handle prop changes
  React.useEffect(() => {
    if (charmInstance.current) {
      loadAndRunCharm();
    }
  }, [argument, charmImport]);

  return (
    <>
      {isLoading && <div>Loading...</div>}
      {error && <div>Error loading charm</div>}
      <div className={className} ref={containerRef}></div>
    </>
  );
}
