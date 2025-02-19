import { NavLink } from "react-router-dom";
import { LuPencil } from "react-icons/lu";
import ShapeLogo from "@/assets/ShapeLogo.svg";
import { NavPath } from "@/components/NavPath";

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
      <div className="header-end">
        {charmId && (
          <NavLink
            to={togglePath}
            className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              isDetailActive
                ? "bg-gray-300 hover:bg-gray-400 text-black"
                : "bg-transparent text-black  hover:bg-gray-200"
            }`}
          >
            <LuPencil size={16} />
          </NavLink>
        )}
      </div>
    </header>
  );
}

export default ShellHeader;
