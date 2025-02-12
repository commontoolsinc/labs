import React, { useRef } from "react";
import { render } from "@commontools/html";
import { effect } from "@commontools/runner";
import { useCharmManager } from "@/contexts/CharmManagerContext";

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

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // FIXME(ja): we don't have a cleanup function here!
    // how can we mix all the effects and react useeffect
    effect(charm.asCell(), (charm) => {
      effect(charm['$UI'], (view) => {
        if (!view) {
          console.log("no UI");
          return;
        }
        render(container, view as any);
      });
    });

    return () => {
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [charm]);

  return <div className={className} ref={containerRef}></div>;
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
