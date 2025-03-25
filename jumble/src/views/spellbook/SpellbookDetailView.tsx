// SpellbookDetailView.tsx

import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
// Import JsonView without type checking
import JsonView from "@uiw/react-json-view";
import {
  LuBookOpen,
  LuChevronDown,
  LuChevronRight,
  LuHeart,
  LuMessageSquare,
  LuSend,
  LuShare2,
  LuTrash2,
} from "react-icons/lu";
import {
  createComment,
  deleteSpell,
  getSpellbookBlob,
  shareSpell,
  type Spell,
  toggleLike,
  trackRun,
  type UserProfile,
  whoami,
} from "@/services/spellbook.ts";
import { ActionButton } from "@/components/spellbook/ActionButton.tsx";
import { SpellbookHeader } from "@/components/spellbook/SpellbookHeader.tsx";
import { SpellPreview } from "@/components/spellbook/SpellPreview.tsx";
import { createPath } from "@/routes.ts";
import { useTheme } from "@/contexts/ThemeContext.tsx";

export default function SpellbookDetailView() {
  const { spellId } = useParams<{ spellId: string }>();
  const navigate = useNavigate();
  const [spell, setSpell] = useState<Spell | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDetailsExpanded, setIsDetailsExpanded] = useState(false);
  const [isCommentsExpanded, setIsCommentsExpanded] = useState(true);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(true);
  const [commentText, setCommentText] = useState("");
  const { isDarkMode } = useTheme();

  // FIXME(jake): This should be moved to its own context, but avoiding for now since it will change with webauthn
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);

  const isLiked = spell?.likes.includes(currentUser?.shortName || "") || false;

  useEffect(() => {
    const fetchUser = async () => {
      try {
        const user = await whoami();
        setCurrentUser(user);
      } catch (error) {
        console.error("Failed to fetch user:", error);
      }
    };

    fetchUser();
  }, []);

  useEffect(() => {
    const fetchSpell = async () => {
      if (!spellId) return;
      try {
        const spell = await getSpellbookBlob(spellId);
        setSpell(spell);
      } catch (error) {
        console.error("Failed to fetch spell:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchSpell();
  }, [spellId]);

  const handleShare = async () => {
    if (!spellId || !spell) return;

    try {
      const url = `${globalThis.location.origin}/spellbook/${spellId}`;
      await navigator.clipboard.writeText(url);

      const { shares } = await shareSpell(spellId);
      setSpell({
        ...spell,
        shares,
      });
    } catch (error) {
      console.error("Failed to share spell:", error);
    }
  };

  const handleRun = async () => {
    if (!spellId || !spell) return;

    try {
      // Optimistically update the run count
      setSpell({
        ...spell,
        runs: (spell.runs || 0) + 1,
      });

      // Get the last used replica from localStorage
      const replicaName = localStorage.getItem("lastReplica") ||
        "common-knowledge";

      // Navigate immediately with the replicaName
      navigate(createPath("spellbookLaunch", { replicaName, spellId }));

      // Track the run in the background
      await trackRun(spellId);
    } catch (error) {
      console.error("Failed to run spell:", error);
      // Revert the optimistic update on error
      setSpell({
        ...spell,
        runs: spell.runs || 0,
      });
    }
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

  const handleComment = async () => {
    if (!spellId || !spell) return;

    try {
      const comment = await createComment(spellId, commentText);
      setSpell({
        ...spell,
        comments: [...spell.comments, comment],
      });
      setCommentText("");
    } catch (error) {
      console.error("Failed to create comment:", error);
    }
  };

  const handleDelete = async () => {
    if (!spellId || !spell) return;

    if (
      !confirm(
        "Are you sure you want to delete this spell? This action cannot be undone.",
      )
    ) {
      return;
    }

    try {
      const success = await deleteSpell(spellId);
      if (success) {
        navigate(createPath("spellbookIndex"));
      }
    } catch (error) {
      console.error("Failed to delete spell:", error);
    }
  };

  const content = loading || !spell || !spellId
    ? (
      <div className="container mx-auto">
        <div className="text-center dark:text-white">Loading spell...</div>
      </div>
    )
    : (
      <div className="container mx-auto max-w-4xl flex flex-col gap-4">
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold dark:text-white">
                {spell.title}
              </h1>
              <p className="text-gray-600 dark:text-gray-400">
                by {spell.author}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              {spell.tags.map((tag) => (
                <NavLink
                  key={tag}
                  to={`/spellbook?q=${encodeURIComponent(tag)}`}
                  className="text-sm bg-gray-100 dark:bg-dark-bg-tertiary dark:text-dark-text-primary px-2 py-1 border border-black dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-dark-bg-primary cursor-pointer transition-colors"
                >
                  {tag}
                </NavLink>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-dark-bg-secondary border-2 border-black dark:border-gray-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[2px_2px_0px_0px_rgba(80,80,80,0.5)]">
          <div className="relative aspect-video w-full border-b-2 border-black dark:border-gray-600 overflow-hidden">
            <SpellPreview ui={spell.ui} />
          </div>

          <div className="p-6">
            <div className="flex gap-2 justify-between">
              <ActionButton
                icon={<LuShare2 size={24} />}
                label={`${spell.shares} ${
                  spell.shares === 1 ? "Share" : "Shares"
                }`}
                onClick={handleShare}
                popoverMessage="Shareable spell link copied to clipboard!"
              />

              <ActionButton
                icon={
                  <LuHeart
                    size={24}
                    className={isLiked
                      ? (isDarkMode ? "fill-white" : "fill-black")
                      : ""}
                  />
                }
                label={`${spell.likes.length} ${
                  spell.likes.length === 1 ? "Like" : "Likes"
                }`}
                onClick={handleLike}
                popoverMessage={isLiked ? "Liked!" : "Unliked!"}
              />
              <ActionButton
                icon={<LuSend size={24} />}
                label={`${spell.runs || 0} ${
                  (spell.runs || 0) === 1 ? "Run" : "Runs"
                }`}
                onClick={handleRun}
                popoverMessage="Launching spell..."
              />
              {currentUser?.shortName === spell.author && (
                <ActionButton
                  icon={<LuTrash2 size={24} />}
                  label="Delete"
                  onClick={handleDelete}
                  className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                  popoverMessage="Delete spell"
                />
              )}
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
                  <span className="text-lg font-semibold">
                    Spellbook Description
                  </span>
                </div>
              }
              label={isDescriptionExpanded
                ? <LuChevronDown className="w-5 h-5" />
                : <LuChevronRight className="w-5 h-5" />}
              onClick={() => setIsDescriptionExpanded(!isDescriptionExpanded)}
              popoverMessage=""
            />
            {isDescriptionExpanded && (
              <div className="p-8 border-2 border-black dark:border-gray-600 dark:bg-dark-bg-secondary">
                <p className="text-gray-600 dark:text-gray-300 text-lg">
                  {spell.description}
                </p>
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
            label={isCommentsExpanded
              ? <LuChevronDown className="w-5 h-5" />
              : <LuChevronRight className="w-5 h-5" />}
            onClick={() => setIsCommentsExpanded(!isCommentsExpanded)}
            popoverMessage=""
          />
          {isCommentsExpanded && (
            <div className="p-8 border-2 border-black dark:border-gray-600 dark:bg-dark-bg-secondary">
              <div className="flex flex-col gap-6">
                <div className="flex flex-col gap-2">
                  <textarea
                    className="w-full px-3 py-2 bg-white dark:bg-dark-bg-tertiary dark:text-white border-2 border-black dark:border-gray-600 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[2px_2px_0px_0px_rgba(80,80,80,0.5)] focus:outline-none focus:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)] dark:focus:shadow-[2px_2px_0px_0px_rgba(100,100,100,0.6)] placeholder:text-gray-500 dark:placeholder:text-gray-400"
                    placeholder="Add a comment..."
                    rows={3}
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                  />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      className="px-4 py-2 bg-black dark:bg-gray-700 text-white hover:bg-gray-800 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      onClick={handleComment}
                      disabled={!commentText.trim()}
                    >
                      Post Comment
                    </button>
                  </div>
                </div>

                {[...spell.comments]
                  .sort(
                    (a, b) =>
                      new Date(b.createdAt).getTime() -
                      new Date(a.createdAt).getTime(),
                  )
                  .map((comment) => (
                    <div key={comment.id} className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <img
                          src={comment.authorAvatar}
                          alt={comment.author}
                          className="w-6 h-6 rounded-full"
                        />
                        <span className="font-semibold dark:text-white">
                          {comment.author}
                        </span>
                        <span className="text-gray-600 dark:text-gray-400 text-sm">
                          {new Date(comment.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                      <p className="text-gray-800 dark:text-gray-200">
                        {comment.content}
                      </p>
                    </div>
                  ))}
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
            label={isDetailsExpanded
              ? <LuChevronDown className="w-5 h-5" />
              : <LuChevronRight className="w-5 h-5" />}
            onClick={() => setIsDetailsExpanded(!isDetailsExpanded)}
            popoverMessage=""
          />
          {isDetailsExpanded && (
            <div className="p-8 border-2 border-black dark:border-gray-600 dark:bg-dark-bg-secondary">
              {/* @ts-expect-error JsonView is imported as any */}
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
    <div className="shell h-screen flex flex-col bg-gray-50 dark:bg-dark-bg-primary border-2 border-black dark:border-gray-600">
      <SpellbookHeader />
      <div className="flex-1 overflow-auto">
        <div className="p-4 pb-8">{content}</div>
      </div>
    </div>
  );
}
