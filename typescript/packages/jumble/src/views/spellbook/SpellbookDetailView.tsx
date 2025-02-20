// SpellbookDetailView.tsx

import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import JsonView from "@uiw/react-json-view";
import { LuHeart, LuBookOpen, LuSend, LuCode } from "react-icons/lu";
import { getBlobByHash } from "@/services/blobby";
import { ActionButton } from "@/components/spellbook/ActionButton";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader";
import { SpellPreview } from "@/components/spellbook/SpellPreview";

export default function SpellbookDetailView() {
  const { hash } = useParams<{ hash: string }>();
  const [spell, setSpell] = useState<any>(null);
  const [isLiked, setIsLiked] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchSpell = async () => {
      if (!hash) return;
      try {
        const data = await getBlobByHash(hash);
        setSpell(data);
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

        <div
          className="
        bg-white border-2 border-black
        shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
      "
        >
          <div className="relative aspect-video w-full border-b-2 border-black overflow-hidden">
            <SpellPreview data={spell} />
          </div>

          <div className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <h1 className="text-2xl font-bold">{spell.recipeName || "Unnamed Spell"}</h1>
            </div>

            <div className="mb-8">
              <p className="text-gray-600">first created by {spell.blobAuthor || "Anonymous"}</p>
            </div>

            <div className="border-2 border-black p-4">
              <div className="flex items-center mb-4">
                <LuBookOpen className="w-5 h-5 mr-2" />
                <h2 className="text-lg font-semibold">Spell Details</h2>
              </div>
              <JsonView
                value={spell}
                style={{
                  background: "transparent",
                  fontSize: "0.875rem",
                }}
              />
            </div>
          </div>
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
