// SpellbookDetailView.tsx

import { useState, useEffect } from "react";
import { useParams, NavLink } from "react-router-dom";
import JsonView from "@uiw/react-json-view";
import { LuHeart, LuBookOpen, LuSend, LuCode, LuChevronDown, LuChevronRight } from "react-icons/lu";
import { getBlobByHash } from "@/services/blobby";
import { ActionButton } from "@/components/spellbook/ActionButton";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader";
import { SpellPreview } from "@/components/spellbook/SpellPreview";

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

export default function SpellbookDetailView() {
  const { hash } = useParams<{ hash: string }>();
  const [spell, setSpell] = useState<SpellbookSpell | null>(null);
  const [isLiked, setIsLiked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);

  useEffect(() => {
    const fetchSpell = async () => {
      if (!hash) return;
      try {
        const data = await getBlobByHash(hash);
        setSpell({
          hash,
          title: data.spellbookTitle || data.recipeName || "Unnamed Spell",
          tags: data.spellbookTags || [],
          ui: data.spellbookUI || null,
          description: data.spellbookDescription || "",
          publishedAt: data.spellbookPublishedAt || "",
          author: data.spellbookAuthor || "Anonymous",
          data,
        });
      } catch (error) {
        console.error("Failed to fetch spell:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSpell();
  }, [hash]);

  const handleShare = () => {
    if (!hash) return;
    const url = `${window.location.origin}/spellbook/${hash}`;
    navigator.clipboard.writeText(url);
  };

  const handleCopyBlobbyLink = () => {
    if (!hash) return;
    const url = `https://paas.saga-castor.ts.net/blobby/blob/${hash}`;
    navigator.clipboard.writeText(url);
  };

  const handleLike = () => {
    setIsLiked(!isLiked);
    // TODO: Make API call to whatever service is handling likes
  };

  const content =
    loading || !spell || !hash ? (
      <div className="container mx-auto">
        <div className="text-center">Loading spell...</div>
      </div>
    ) : (
      <div className="container mx-auto max-w-4xl flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold">{spell.title}</h1>
              <p className="text-gray-600">by {spell.author}</p>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              {spell.tags.map((tag) => (
                <NavLink
                  key={tag}
                  to={`/spellbook?q=${encodeURIComponent(tag)}`}
                  className="text-sm bg-gray-100 px-2 py-1 border border-black hover:bg-gray-200 cursor-pointer transition-colors"
                >
                  {tag}
                </NavLink>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white border-2 border-black shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]">
          <div className="relative aspect-video w-full border-b-2 border-black overflow-hidden">
            <SpellPreview ui={spell.ui} />
          </div>

          <div className="p-6">
            <div className="flex gap-2 justify-between">
              <ActionButton
                icon={<LuCode size={24} />}
                label="Blobby"
                onClick={handleCopyBlobbyLink}
                popoverMessage="Blobby link copied to clipboard!"
              />
              <ActionButton
                icon={<LuHeart size={24} className={isLiked ? "fill-black" : ""} />}
                label="Like"
                onClick={handleLike}
                popoverMessage="Liked!"
              />
              <ActionButton
                icon={<LuSend size={24} />}
                label="Share"
                onClick={handleShare}
                popoverMessage="Shareable spell link copied to clipboard!"
              />
            </div>
          </div>
        </div>

        {spell.description && (
          <div className="border-2 border-black p-4">
            <p className="text-gray-600 text-lg">{spell.description}</p>
          </div>
        )}

        <div className="spell-details">
          <ActionButton
            className="w-full"
            icon={
              <div className="flex items-center gap-2">
                <LuBookOpen className="w-5 h-5" />
                <span className="text-lg font-semibold">Spellbook Data</span>
              </div>
            }
            label={
              isDetailsExpanded ? (
                <LuChevronDown className="w-5 h-5" />
              ) : (
                <LuChevronRight className="w-5 h-5" />
              )
            }
            onClick={() => setIsDetailsExpanded(!isDetailsExpanded)}
            popoverMessage=""
          />
          {isDetailsExpanded && (
            <div className="p-8 border-2 border-black">
              <JsonView
                value={spell.data}
                style={{
                  background: "transparent",
                  fontSize: "0.875rem",
                }}
              />
            </div>
          )}
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
