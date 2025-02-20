// SpellbookIndexView.tsx

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { SearchBox } from "@/components/spellbook/SearchBox";
import SpellCard from "@/components/spellbook/SpellCard";
import { getAllSpellbookBlobs, getBlobByHash } from "@/services/blobby";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader";
import { LoadingSpinner } from "@/components/Loader";

interface SpellbookSpell {
  hash: string;
  title: string;
  tags: string[];
  ui: any;
  description: string;
  publishedAt: string;
  author: string;
  data: any;
}

export default function SpellbookIndexView() {
  const [spells, setSpells] = useState<SpellbookSpell[]>([]);
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const searchQuery = searchParams.get("q")?.toLowerCase() || "";

  useEffect(() => {
    const fetchSpells = async () => {
      try {
        const hashes = await getAllSpellbookBlobs();
        console.log("hashes", hashes);
        const spellPromises = hashes.map(async (hash) => {
          const data = await getBlobByHash(hash);
          return {
            hash,
            title: data.spellbookTitle || data.recipeName || "Unnamed Spell",
            tags: data.spellbookTags || [],
            ui: data.spellbookUI || null,
            description: data.spellbookDescription || "",
            publishedAt: data.spellbookPublishedAt || "",
            author: data.spellbookAuthor || "Anonymous",
            data,
            // TODO(jake): add likes and comments, once we have API
            // spellbookLikes: data.spellbookLikes || 0,
            // spellbookComments: data.spellbookComments || [],
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
      spell.title.toLowerCase().includes(searchQuery) ||
      spell.description.toLowerCase().includes(searchQuery) ||
      spell.tags.some((tag) => tag.toLowerCase().includes(searchQuery))
    );
  });

  const content = loading ? (
    <div className="flex justify-center items-center h-[50vh]">
      <LoadingSpinner height={256} width={256} cameraZoom={50} />
    </div>
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
            title={spell.title}
            tags={spell.tags}
            ui={spell.ui}
            description={spell.description}
            publishedAt={spell.publishedAt}
            author={spell.author}
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
