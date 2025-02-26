// hooks/useCharmPublisher.tsx
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useSpaceManager } from "@/contexts/SpaceManagerContext.tsx";
import { TYPE } from "@commontools/builder";
import { saveSpell } from "@/services/spellbook.ts";
import { ShareDialog } from "@/components/spellbook/ShareDialog.tsx";

function useCharmPublisher() {
  const { spaceManager } = useSpaceManager();
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

  const handleShare = async (data: { title: string; description: string; tags: string[] }) => {
    if (!currentCharmId) return;

    setIsPublishing(true);
    try {
      const charm = await spaceManager.get(currentCharmId);
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
  };

  return {
    isShareDialogOpen,
    setIsShareDialogOpen,
    isPublishing,
    handleShare,
    defaultTitle: currentCharmName || "",
  };
}

export function CharmPublisher() {
  const { isShareDialogOpen, setIsShareDialogOpen, isPublishing, handleShare, defaultTitle } =
    usePublish();

  return (
    <ShareDialog
      isOpen={isShareDialogOpen}
      onClose={() => setIsShareDialogOpen(false)}
      onSubmit={handleShare}
      defaultTitle={defaultTitle}
      isPublishing={isPublishing}
    />
  );
}
