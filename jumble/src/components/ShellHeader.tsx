import { NavLink } from "react-router-dom";
import ShapeLogo from "@/assets/ShapeLogo.tsx";
import { NavPath } from "@/components/NavPath.tsx";
import { User } from "@/components/User.tsx";

type ShellHeaderProps = {
  /**
   * DID of the space.
   */
  session: { space: string; name: string };
  charmId?: string;
};

export function ShellHeader(
  { session, charmId }: ShellHeaderProps,
) {
  return (
    <header className="flex bg-gray-50 items-center justify-between border-b-2 p-2">
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
