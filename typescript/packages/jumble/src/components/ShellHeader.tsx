import { useState } from "react";
import { NavLink } from "react-router-dom";
import { LuPencil, LuShare2 } from "react-icons/lu";
import ShapeLogo from "@/assets/ShapeLogo.svg";
import { NavPath } from "@/components/NavPath";
import { ShareDialog } from "@/components/spellbook/ShareDialog";

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
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

  const handleShare = (data: { title: string; description: string; tags: string[] }) => {
    console.log("Share data:", data);
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
        {charmId && (
          <>
            <NavLink
              to={togglePath}
              className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors relative group ${
                isDetailActive
                  ? "bg-gray-300 hover:bg-gray-400 text-black"
                  : "bg-transparent text-black  hover:bg-gray-200"
              }`}
            >
              <LuPencil size={16} />
              <div className="absolute top-10 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Edit
              </div>
            </NavLink>
            <button
              onClick={() => setIsShareDialogOpen(true)}
              className="w-10 h-10 flex items-center justify-center rounded-lg transition-colors relative group bg-transparent text-black hover:bg-gray-200"
            >
              <LuShare2 size={16} />
              <div className="absolute top-10 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Share
              </div>
            </button>
          </>
        )}
        <NavLink
          to="/spellbook"
          className="brand flex items-center gap-2 opacity-30 hover:opacity-100 transition-opacity duration-200 relative group"
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
      />
    </header>
  );
}

export default ShellHeader;
