// SpellbookIndexView.tsx

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { SearchBox } from "@/components/spellbook/SearchBox";
import SpellCard from "@/components/spellbook/SpellCard";
import { getAllSpellbookBlobs, getBlobByHash, getBlobScreenshotUrl } from "@/services/blobby";

interface Spell {
  hash: string;
  name: string;
  author: string;
  spellbookTitle: string;
  spellbookTags: string[];
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

  if (loading) {
    return (
      <div className="min-h-screen bg-purple-50 p-4 md:p-8">
        <div className="container mx-auto">
          <div className="text-center">Loading spells...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-purple-50 p-4 md:p-8">
      <div className="container mx-auto">
        <div className="mb-8">
          <h1 className="mb-4 text-3xl font-bold text-purple-900">Spellbook</h1>
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
              imageUrl={getBlobScreenshotUrl(spell.hash)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
