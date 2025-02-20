// SpellbookDetailView.tsx

import { useState, useEffect } from "react";
import { useParams, NavLink } from "react-router-dom";
import JsonView from "@uiw/react-json-view";
import {
  LuHeart,
  LuBookOpen,
  LuSend,
  LuCode,
  LuChevronDown,
  LuChevronRight,
  LuMessageSquare,
} from "react-icons/lu";
import { getSpell, type Spell, toggleLike } from "@/services/spellbook";
import { ActionButton } from "@/components/spellbook/ActionButton";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader";
import { SpellPreview } from "@/components/spellbook/SpellPreview";

export default function SpellbookDetailView() {
  const { spellId } = useParams<{ spellId: string }>();
  const [spell, setSpell] = useState<Spell | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [isCommentsExpanded, setIsCommentsExpanded] = useState(true);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(true);

  // Get the current user's shortname from the URL
  const currentUser =
    window.location.hostname === "localhost" ? "system" : window.location.hostname.split(".")[0];
  const isLiked = spell?.likes.includes(currentUser) || false;

  useEffect(() => {
    const fetchSpell = async () => {
      if (!spellId) return;
      try {
        const spell = await getSpell(spellId);
        setSpell(spell);
      } catch (error) {
        console.error("Failed to fetch spell:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSpell();
  }, [spellId]);

  const handleShare = () => {
    if (!spellId) return;
    const url = `${window.location.origin}/spellbook/${spellId}`;
    navigator.clipboard.writeText(url);
  };

  const handleCopyBlobbyLink = () => {
    if (!spellId) return;
    const url = `https://paas.saga-castor.ts.net/blobby/blob/${spellId}`;
    navigator.clipboard.writeText(url);
  };

  const handleLike = async () => {
    if (!spellId || !spell) return;

    try {
      const { likes } = await toggleLike(spellId);

      setSpell({
        ...spell,
        likes,
      });
    } catch (error) {
      console.error("Failed to toggle like:", error);
    }
  };

  const content =
    loading || !spell || !spellId ? (
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
                label={`${spell.likes.length} Likes`}
                onClick={handleLike}
                popoverMessage={isLiked ? "Liked!" : "Unliked!"}
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
          <div className="spell-description">
            <ActionButton
              className="w-full"
              icon={
                <div className="flex items-center gap-2">
                  <LuBookOpen className="w-5 h-5" />
                  <span className="text-lg font-semibold">Spellbook Description</span>
                </div>
              }
              label={
                isDescriptionExpanded ? (
                  <LuChevronDown className="w-5 h-5" />
                ) : (
                  <LuChevronRight className="w-5 h-5" />
                )
              }
              onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
              popoverMessage=""
            />
            {isDescriptionExpanded && (
              <div className="p-8 border-2 border-black">
                <p className="text-gray-600 text-lg">{spell.description}</p>
              </div>
            )}
          </div>
        )}

        <div className="spell-comments">
          <ActionButton
            className="w-full"
            icon={
              <div className="flex items-center gap-2">
                <LuMessageSquare className="w-5 h-5" />
                <span className="text-lg font-semibold">Comments</span>
              </div>
            }
            label={
              isCommentsExpanded ? (
                <LuChevronDown className="w-5 h-5" />
              ) : (
                <LuChevronRight className="w-5 h-5" />
              )
            }
            onClick={() => setIsCommentsExpanded(!isCommentsExpanded)}
            popoverMessage=""
          />
          {isCommentsExpanded && (
            <div className="p-8 border-2 border-black">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Alice</span>
                    <span className="text-gray-600 text-sm">2 days ago</span>
                  </div>
                  <p className="text-gray-800">
                    This spell is amazing! I've been looking for something exactly like this.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Bob</span>
                    <span className="text-gray-600 text-sm">1 day ago</span>
                  </div>
                  <p className="text-gray-800">
                    Great work! Would love to see a version that also handles edge cases.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">Charlie</span>
                    <span className="text-gray-600 text-sm">5 hours ago</span>
                  </div>
                  <p className="text-gray-800">
                    Just what I needed for my project. Thanks for sharing!
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

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
    <div className="shell h-screen flex flex-col bg-gray-50 border-2 border-black">
      <SpellbookHeader />
      <div className="flex-1 overflow-auto">
        <div className="p-4 pb-8">{content}</div>
      </div>
    </div>
  );
}
