import { NavLink } from "react-router-dom";
import ShapeLogo from "@/assets/ShapeLogo.tsx";
import { NavPath } from "@/components/NavPath.tsx";
import { User } from "@/components/User.tsx";
import { useSyncedStatus } from "@/contexts/SyncStatusContext.tsx";
import { useNamedCell } from "@/hooks/use-cell.ts";
import { getSpace } from "@commontools/runner";

type ShellHeaderProps = {
  /**
   * DID of the space.
   */
  session: { space: string; name: string };
  charmId?: string;
};

const colorCause = { shell: "header v0" };
const colorSchema = {
  type: "object" as const,
  properties: {
    color: {
      type: "string" as const,
      default: "transparent",
    },
  },
  required: ["color"],
} as const;

export function ShellHeader(
  { session, charmId }: ShellHeaderProps,
) {
  const { isSyncing, lastSyncTime } = useSyncedStatus();
  const colorSpace = getSpace(session.space);

  const [style, setStyle] = useNamedCell(
    colorSpace,
    colorCause,
    colorSchema,
  );

  const handleHeaderClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      const randomColor = `#${
        Math.floor(Math.random() * 16777215).toString(16)
      }`;
      setStyle({ color: randomColor });
    }
  };

  return (
    <header
      className="flex bg-gray-50 items-center justify-between border-b-2 p-2"
      style={{ backgroundColor: style?.color }}
      onClick={handleHeaderClick}
      title="Click empty space to change header color"
    >
      <div className="header-start flex items-center gap-2">
        <NavLink
          to={`/${session.name}`}
          className="brand flex items-center gap-2"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor="#000"
            containerColor="#d2d2d2"
          />
        </NavLink>
        <NavPath replicaId={session.name} charmId={charmId} />
      </div>
      <div className="header-end flex items-center gap-2">
        <div className="relative group">
          <div
            className={`w-3 h-3 rounded-full ${
              isSyncing ? "bg-yellow-400 animate-pulse" : "bg-green-500 "
            }`}
          />
          <div className="absolute top-6 left-1/2 -translate-x-1/2 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
            {isSyncing
              ? lastSyncTime
                ? `Pending since ${
                  new Date(lastSyncTime).toLocaleTimeString()
                })`
                : "Pending..."
              : lastSyncTime
              ? `Connected`
              : "Connected"}
          </div>
        </div>
        <User />

        <NavLink
          to="/spellbook"
          className="brand flex items-center gap-2 opacity-30 hover:opacity-100 transition-opacity duration-200 relative group cursor-pointer z-10"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor="#7F08EA"
            containerColor="#B77EEA"
          />
          <div className="absolute top-10 left-1/2 -translate-x-2/3 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Spellbook
          </div>
        </NavLink>
      </div>
    </header>
  );
}

export default ShellHeader;
