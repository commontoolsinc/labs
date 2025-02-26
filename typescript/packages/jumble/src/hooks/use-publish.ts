// hooks/useCharmPublisher.tsx
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { TYPE } from "@commontools/builder";
import { saveSpell } from "@/services/spellbook.ts";

export function usePublish() {
  const { charmManager } = useCharmManager();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const navigate = useNavigate();
  const [currentCharmId, setCurrentCharmId] = useState<string | undefined>();
  const [currentCharmName, setCurrentCharmName] = useState<string | null>(null);

  useEffect(() => {
    const handlePublishCharm = (event: CustomEvent) => {
      const { charmId, charmName } = event.detail || {};
      if (charmId) {
        setCurrentCharmId(charmId);
        setCurrentCharmName(charmName || null);
        setIsShareDialogOpen(true);
      }
    };

    window.addEventListener("publish-charm", handlePublishCharm as EventListener);

    return () => {
      window.removeEventListener("publish-charm", handlePublishCharm as EventListener);
    };
  }, []);

  const handleShare = useCallback(async (data: { title: string; description: string; tags: string[] }) => {
    if (!currentCharmId) return;

    setIsPublishing(true);
    try {
      const charm = await charmManager.get(currentCharmId);
      if (!charm) throw new Error("Charm not found");
      const spell = charm.getSourceCell()?.get();
      const spellId = spell?.[TYPE];
      if (!spellId) throw new Error("Spell not found");

      const success = await saveSpell(spellId, spell, data.title, data.description, data.tags);

      if (success) {
        const fullUrl = `${window.location.protocol}//${window.location.host}/spellbook/${spellId}`;
        try {
          await navigator.clipboard.writeText(fullUrl);
        } catch (err) {
          console.error("Failed to copy to clipboard:", err);
        }
        navigate(`/spellbook/${spellId}`);
      } else {
        throw new Error("Failed to publish");
      }
    } catch (error) {
      console.error("Failed to publish:", error);
    } finally {
      setIsPublishing(false);
      setIsShareDialogOpen(false);
    }
  }, [currentCharmId, charmManager, navigate]);

  return {
    isShareDialogOpen,
    setIsShareDialogOpen,
    isPublishing,
    handleShare,
    defaultTitle: currentCharmName || "",
  };
}
