import { useEffect, useState } from "react";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";

/**
 * Hook to get charms that the current charm reads from and is read by
 */
export function useCharmReferences(charm: Cell<Charm> | undefined) {
  const { charmManager } = useCharmManager();
  const [readingFrom, setReadingFrom] = useState<Cell<Charm>[]>([]);
  const [readBy, setReadBy] = useState<Cell<Charm>[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!charm) {
      setReadingFrom([]);
      setReadBy([]);
      return;
    }

    setLoading(true);

    // Get references - this could be expensive, so we might want to add caching later
    const readingFromCharms = charmManager.getReadingFrom(charm);
    const readByCharms = charmManager.getReadByCharms(charm);

    setReadingFrom(readingFromCharms);
    setReadBy(readByCharms);
    setLoading(false);
  }, [charm, charmManager]);

  return { readingFrom, readBy, loading };
}
