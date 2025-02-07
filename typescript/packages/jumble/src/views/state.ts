import { SpellSearchResult } from "@/search";
import { CharmManager } from "@commontools/charm";
import { DocImpl, getDoc } from "@commontools/runner";

// bf: probably not the best way to make a cell but it works
export const sidebar = getDoc("home");
export const replica = getDoc("common-knowledge");
export const searchResults: DocImpl<SpellSearchResult[]> = getDoc([]);

export const charmManager = (() => {
  const storageType = replica ? "remote" : ((import.meta as any).env.VITE_STORAGE_TYPE ?? "memory");
  // bf: this needs to change, can go out of date if the cell updates
  return new CharmManager(replica.get(), storageType);
})();
charmManager.init();
