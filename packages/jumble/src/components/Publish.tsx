import { ShareDialog } from "@/components/spellbook/ShareDialog.tsx";
import { usePublish } from "@/hooks/use-publish.ts";

export function CharmPublisher() {
  const {
    isShareDialogOpen,
    setIsShareDialogOpen,
    isPublishing,
    handleShare,
    defaultTitle,
  } = usePublish();

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
