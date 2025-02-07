import { Charm } from "@commontools/charm";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { CharmRenderer } from "@/components/CharmRunner";
import { useCharmManager } from "@/contexts/CharmManagerContext";

export default function CharmDetail() {
  const { charmManager } = useCharmManager();
  const { charmId } = useParams();
  const [currentFocus, setCurrentFocus] = useState<Charm | null>(null);

  useEffect(() => {
    async function loadCharm() {
      if (charmId) {
        await charmManager.init();
        const charm = (await charmManager.get(charmId)) ?? null;
        if (charm) {
          await charmManager.syncRecipe(charm);
        }

        setCurrentFocus(charm);
      }
    }
    loadCharm();
  }, [charmId, charmManager]);

  if (!currentFocus) {
    return <div>Loading...</div>;
  }

  return <CharmRenderer className="h-full" charm={currentFocus} />;
}
