// SpellbookIndexView.tsx

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { SearchBox } from "@/components/spellbook/SearchBox.tsx";
import SpellCard from "@/components/spellbook/SpellCard.tsx";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader.tsx";
import { LoadingSpinner } from "@/components/Loader.tsx";
import { listAllSpells, type Spell } from "@/services/spellbook.ts";

export default function SpellbookIndexView() {
  const [spells, setSpells] = useState<Spell[]>([]);
  const [loading, setLoading] = useState(true);
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const searchQuery = searchParams.get("q")?.toLowerCase() || "";

  useEffect(() => {
    const fetchSpells = async () => {
      try {
        const spells = await listAllSpells(searchQuery);
        setSpells(spells);
      } catch (error) {
        console.error("Failed to fetch spells:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSpells();
  }, [searchQuery]);

  const content = loading
    ? (
      <div className="flex justify-center items-center h-[50vh]">
        <LoadingSpinner height={256} width={256} cameraZoom={50} />
      </div>
    )
    : (
      <div>
        <div className="mb-8">
          <SearchBox defaultValue={searchQuery} />
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {spells.map((spell) => (
            <SpellCard
              key={spell.id}
              spellId={spell.id}
              title={spell.title}
              tags={spell.tags}
              ui={spell.ui}
              likes={spell.likes.length}
              comments={spell.comments.length}
              shares={spell.shares}
            />
          ))}
        </div>
      </div>
    );

  return (
    <div className="shell h-screen flex flex-col bg-gray-50 border-2 border-black">
      <SpellbookHeader />
      <div className="flex-1 overflow-auto">
        <div className="p-4 pb-8">{content}</div>
      </div>
    </div>
  );
}
