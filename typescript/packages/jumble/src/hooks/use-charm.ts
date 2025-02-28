import { useSpaceManager } from "@/contexts/SpaceManagerContext";
import { Charm, getIframeRecipe, IFrameRecipe } from "@commontools/charm";
import { Cell, effect } from "@commontools/runner";
import React from "react";

export const useCharm = (charmId: string | undefined) => {
  const { spaceManager } = useSpaceManager();
  const [currentFocus, setCurrentFocus] = React.useState<Cell<Charm> | null>(null);
  const [iframeRecipe, setIframeRecipe] = React.useState<IFrameRecipe | null>(null);

  React.useEffect(() => {
    async function loadCharm() {
      if (charmId) {
        const charm = (await spaceManager.get(charmId)) ?? null;
        if (charm) {
          await spaceManager.syncRecipe(charm);
          const ir = getIframeRecipe(charm);
          setIframeRecipe(ir?.iframe ?? null);
        }
        setCurrentFocus(charm);
      }
    }

    loadCharm();

    // Subscribe to changes in the charms list
    const cleanup = effect(spaceManager.getCharms(), () => {
      loadCharm();
    });

    // Cleanup subscription when component unmounts or charmId/spaceManager changes
    return cleanup;
  }, [charmId, spaceManager]);

  return {
    currentFocus,
    iframeRecipe,
  };
};
