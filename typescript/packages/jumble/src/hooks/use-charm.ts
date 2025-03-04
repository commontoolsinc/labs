import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { Charm, getIframeRecipe, IFrameRecipe } from "@commontools/charm";
import { Cell, effect } from "@commontools/runner";
import React from "react";

export const useCharm = (charmId: string | undefined) => {
  const { charmManager } = useCharmManager();
  const [currentFocus, setCurrentFocus] = React.useState<Cell<Charm> | null>(
    null,
  );
  const [iframeRecipe, setIframeRecipe] = React.useState<IFrameRecipe | null>(
    null,
  );

  React.useEffect(() => {
    async function loadCharm() {
      if (charmId) {
        const charm = (await charmManager.get(charmId)) ?? null;
        if (charm) {
          await charmManager.syncRecipe(charm);
          const ir = await getIframeRecipe(charm);
          setIframeRecipe(ir?.iframe ?? null);
        }
        setCurrentFocus(charm);
      }
    }

    loadCharm();

    // Subscribe to changes in the charms list
    const cleanup = effect(charmManager.getCharms(), () => {
      loadCharm();
    });

    // Cleanup subscription when component unmounts or charmId/charmManager changes
    return cleanup;
  }, [charmId, charmManager]);

  return {
    currentFocus,
    iframeRecipe,
  };
};
