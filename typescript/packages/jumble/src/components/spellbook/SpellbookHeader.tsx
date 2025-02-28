import { NavLink } from "react-router-dom";
import ShapeLogo from "@/assets/ShapeLogo.tsx";

export function SpellbookHeader() {
  return (
    <header className="flex bg-gray-50 items-center justify-between border-b-2 p-2">
      <div className="header-start flex items-center gap-2">
        <NavLink to="/spellbook" className="brand flex items-center gap-2">
          <ShapeLogo
            width={32}
            height={32}
            shapeColor="#7F08EA"
            containerColor="#B77EEA"
          />
          <span className="text-lg font-bold">Spellbook</span>
        </NavLink>
      </div>
      <div className="header-end flex items-center gap-2">
        <NavLink
          to="/"
          className="text-sm text-gray-500 flex items-center gap-2 relative group"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor="#000"
            containerColor="#d2d2d2"
          />
          <div className="absolute top-10 left-1/2 -translate-x-2/3 bg-gray-800 text-white px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Jumble
          </div>
        </NavLink>
      </div>
    </header>
  );
}
