// SpellbookIndexView.tsx

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { SearchBox } from "@/components/spellbook/SearchBox";
import SpellCard from "@/components/spellbook/SpellCard";
import { getAllSpellbookBlobs, getBlobByHash } from "@/services/blobby";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader";

interface Spell {
  hash: string;
  name: string;
  author: string;
  spellbookTitle: string;
  spellbookTags: string[];
  data: any;
}

export default function SpellbookIndexView() {
  const [spells, setSpells] = useState<Spell[]>([]);
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const searchQuery = searchParams.get("q")?.toLowerCase() || "";

  useEffect(() => {
    const fetchSpells = async () => {
      try {
        const hashes = await getAllSpellbookBlobs();
        const spellPromises = hashes.map(async (hash) => {
          const data = await getBlobByHash(hash);
          return {
            hash,
            name: data.recipeName || "Unnamed Spell",
            author: data.blobAuthor || "Anonymous",
            spellbookTitle: data.spellbookTitle || data.recipeName || "Unnamed Spell",
            spellbookTags: data.spellbookTags || [],
            data,
          };
        });
        const spellsData = await Promise.all(spellPromises);
        setSpells(spellsData);
      } catch (error) {
        console.error("Failed to fetch spells:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSpells();
  }, []);

  const filteredSpells = spells.filter((spell) => {
    if (!searchQuery) return true;
    return (
      spell.name.toLowerCase().includes(searchQuery) ||
      spell.spellbookTitle.toLowerCase().includes(searchQuery) ||
      spell.spellbookTags.some((tag) => tag.toLowerCase().includes(searchQuery))
    );
  });

  const content = loading ? (
    <div className="text-center">Loading spells...</div>
  ) : (
    <div>
      <div className="mb-8">
        <SearchBox defaultValue={searchQuery} />
      </div>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {filteredSpells.map((spell) => (
          <SpellCard
            key={spell.hash}
            hash={spell.hash}
            name={spell.name}
            author={spell.author}
            likes={0}
            spellbookTitle={spell.spellbookTitle}
            spellbookTags={spell.spellbookTags}
            data={spell.data}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="shell h-full bg-gray-50 border-2 border-black">
      <SpellbookHeader />
      <div className="relative h-full p-4">{content}</div>
    </div>
  );
}
