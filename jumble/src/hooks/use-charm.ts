import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { Charm, getIframeRecipe, IFrameRecipe } from "@commontools/charm";
import { Cell, effect } from "@commontools/runner";
import React from "react";

// Helper function to load a charm and get its iframe recipe
const loadCharmData = async (
  charmId: string | undefined,
  charmManager: any,
): Promise<
  { charm: Cell<Charm> | null; iframeRecipe: IFrameRecipe | null }
> => {
  if (!charmId) {
    return { charm: null, iframeRecipe: null };
  }

  const charm = (await charmManager.get(charmId)) ?? null;
  let iframeRecipe = null;

  if (charm) {
    try {
      const ir = getIframeRecipe(charm);
      iframeRecipe = ir?.iframe ?? null;
    } catch (e) {
      console.info(e);
    }
  }

  return { charm, iframeRecipe };
};

// Helper to create an effect that reloads charm data when charms change
const createCharmChangeEffect = (
  charmManager: any,
  loadFn: () => void,
): () => void => {
  return effect(charmManager.getCharms(), loadFn);
};

export const useCharm = (charmId: string | undefined) => {
  const { charmManager } = useCharmManager();
  const [currentFocus, setCurrentFocus] = React.useState<Cell<Charm>>();
  const [iframeRecipe, setIframeRecipe] = React.useState<IFrameRecipe>();

  React.useEffect(() => {
    async function loadCharm() {
      const { charm, iframeRecipe: recipe } = await loadCharmData(
        charmId,
        charmManager,
      );
      if (charm) setCurrentFocus(charm);
      if (recipe) setIframeRecipe(recipe);
    }

    loadCharm();

    // Subscribe to changes in the charms list
    const cleanup = createCharmChangeEffect(charmManager, loadCharm);

    // Cleanup subscription when component unmounts or charmId/charmManager changes
    return cleanup;
  }, [charmId, charmManager]);

  return {
    currentFocus,
    iframeRecipe,
  };
};

export const useCharms = (...charmIds: (string | undefined)[]) => {
  const { charmManager } = useCharmManager();
  const [charms, setCharms] = React.useState<(Cell<Charm> | null)[]>([]);
  const [iframeRecipes, setIframeRecipes] = React.useState<
    (IFrameRecipe | null)[]
  >([]);

  // Memoize charmIds to prevent unnecessary rerenders
  const memoizedCharmIds = React.useMemo(() => charmIds, [charmIds.join(",")]);

  // Memoize loadCharms function
  const loadCharms = React.useCallback(async () => {
    if (memoizedCharmIds.length === 0) {
      setCharms([]);
      setIframeRecipes([]);
      return;
    }

    const loadedCharms: (Cell<Charm> | null)[] = [];
    const loadedIframeRecipes: (IFrameRecipe | null)[] = [];

    for (const id of memoizedCharmIds) {
      const { charm, iframeRecipe } = await loadCharmData(id, charmManager);
      loadedCharms.push(charm);
      loadedIframeRecipes.push(iframeRecipe);
    }

    setCharms(loadedCharms);
    setIframeRecipes(loadedIframeRecipes);
  }, [memoizedCharmIds, charmManager]);

  React.useEffect(() => {
    loadCharms();

    // Subscribe to changes in the charms list
    const cleanup = createCharmChangeEffect(charmManager, loadCharms);

    // Cleanup subscription when component unmounts or charmIds/charmManager changes
    return cleanup;
  }, [loadCharms, charmManager]);

  // Memoize the return value
  const result = React.useMemo(() => ({
    charms,
    iframeRecipes,
  }), [charms, iframeRecipes]);

  return result;
};
