import { useState, useEffect } from "react";
import { NavLink } from "react-router-dom";
import { LuPencil, LuShare2 } from "react-icons/lu";
import ShapeLogo from "@/assets/ShapeLogo.svg";
import { NavPath } from "@/components/NavPath";
import { ShareDialog } from "@/components/spellbook/ShareDialog";
import { useCharmManager } from "@/contexts/CharmManagerContext";
import { NAME, TYPE } from "@commontools/builder";
import { useNavigate } from "react-router-dom";
import { saveSpell } from "@/services/spellbook";
import { User } from "@/components/User";

type ShellHeaderProps = {
  replicaName?: string;
  charmId?: string;
  isDetailActive: boolean;
  togglePath: string;
};

export function ShellHeader({
  replicaName,
  charmId,
  isDetailActive,
  togglePath,
}: ShellHeaderProps) {
  const { charmManager } = useCharmManager();
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [charmName, setCharmName] = useState<string | null>(null);
  const [isPublishing, setIsPublishing] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    let mounted = true;
    let cancel: (() => void) | undefined;

    async function getCharm() {
      if (charmId) {
        const charm = await charmManager.get(charmId);
        cancel = charm?.key(NAME).sink((value) => {
          if (mounted) setCharmName(value ?? null);
        });
      }
    }
    getCharm();

    return () => {
      mounted = false;
      cancel?.();
    };
  }, [charmId, charmManager]);

  const handleShare = async (data: { title: string; description: string; tags: string[] }) => {
    if (!charmId) return;

    setIsPublishing(true);
    try {
      const charm = await charmManager.get(charmId);
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

  return (
    <header className="flex bg-gray-50 items-center justify-between border-b-2 p-2">
      <div className="header-start flex items-center gap-2">
        <NavLink
          to={replicaName ? `/${replicaName}` : "/"}
          className="brand flex items-center gap-2"
        >
          <ShapeLogo width={32} height={32} shapeColor="#000" containerColor="#d2d2d2" />
        </NavLink>
        <NavPath replicaId={replicaName} charmId={charmId} />
      </div>
      <div className="header-end flex items-center gap-2">
        <User />
        {charmId && (
          <>
            <NavLink
              to={togglePath}
              className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors relative group z-10 ${
                isDetailActive
                  ? "bg-gray-300 hover:bg-gray-400 text-black"
                  : "bg-transparent text-black hover:bg-gray-200"
              }`}
            >
              <LuPencil size={16} />
              <div className="absolute top-10 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Edit
              </div>
            </NavLink>
            <button
              onClick={() => setIsShareDialogOpen(true)}
              className="w-10 h-10 flex items-center justify-center rounded-lg transition-colors relative group bg-transparent text-black hover:bg-gray-200 z-10 cursor-pointer"
            >
              <LuShare2 size={16} />
              <div className="absolute top-10 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Publish
              </div>
            </button>
          </>
        )}
        <NavLink
          to="/spellbook"
          className="brand flex items-center gap-2 opacity-30 hover:opacity-100 transition-opacity duration-200 relative group cursor-pointer z-10"
        >
          <ShapeLogo width={32} height={32} shapeColor="#7F08EA" containerColor="#B77EEA" />
          <div className="absolute top-10 left-1/2 -translate-x-2/3 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Spellbook
          </div>
        </NavLink>
      </div>

      <ShareDialog
        isOpen={isShareDialogOpen}
        onClose={() => setIsShareDialogOpen(false)}
        onSubmit={handleShare}
        defaultTitle={charmName || ""}
        isPublishing={isPublishing}
      />
    </header>
  );
}

export default ShellHeader;
