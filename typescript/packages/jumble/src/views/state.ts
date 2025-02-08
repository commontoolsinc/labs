import { SpellSearchResult } from "@/search";
import { DocImpl, getDoc } from "@commontools/runner";

// bf: probably not the best way to make a cell but it works
export const sidebar = getDoc("home");
export const replica = getDoc(
  new URLSearchParams(window.location.search).get("replica") || "common-knowledge",
);
export const searchResults: DocImpl<SpellSearchResult[]> = getDoc([]);
