import { useCharmManager } from "@/contexts/CharmManagerContext";
import { Charm, getIframeRecipe, IFrameRecipe } from "@commontools/charm";
import React from "react";

export const useCharm = (charmId: string | undefined) => {
  const { charmManager } = useCharmManager();
  const [currentFocus, setCurrentFocus] = React.useState<Charm | null>(null);
  const [iframeRecipe, setIframeRecipe] = React.useState<IFrameRecipe | null>(null);

  React.useEffect(() => {
    async function loadCharm() {
      if (charmId) {
        await charmManager.init();
        const charm = (await charmManager.get(charmId)) ?? null;
        if (charm) {
          await charmManager.syncRecipe(charm);
          const ir = getIframeRecipe(charm);
          setIframeRecipe(ir?.iframe ?? null);
          console.log({ iframeRecipe: ir });
        }
        setCurrentFocus(charm);
      }
    }
    loadCharm();
  }, [charmId, charmManager]);

  return {
    currentFocus,
    iframeRecipe,
  };
};
