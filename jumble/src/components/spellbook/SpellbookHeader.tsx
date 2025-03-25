import { NavLink } from "react-router-dom";
import ShapeLogo from "@/assets/ShapeLogo.tsx";
import { useTheme } from "@/contexts/ThemeContext.tsx";

export function SpellbookHeader() {
  const { isDarkMode } = useTheme();

  return (
    <header className="flex bg-gray-50 dark:bg-dark-bg-secondary items-center justify-between border-b-2 border-gray-200 dark:border-dark-border p-2 transition-colors duration-200">
      <div className="header-start flex items-center gap-2">
        <NavLink
          to="/spellbook"
          className="brand flex items-center gap-2 transition-opacity duration-200 hover:opacity-80"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor={isDarkMode ? "#B77EEA" : "#7F08EA"}
            containerColor={isDarkMode ? "#8A4EC0" : "#B77EEA"}
          />
          <span className="text-lg font-bold dark:text-white">Spellbook</span>
        </NavLink>
      </div>
      <div className="header-end flex items-center gap-2">
        <NavLink
          to="/"
          className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2 relative group"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor={isDarkMode ? "#fff" : "#000"}
            containerColor={isDarkMode ? "#4a4a4a" : "#d2d2d2"}
          />
          <div className="absolute top-10 left-1/2 -translate-x-2/3 bg-gray-800 dark:bg-dark-bg-tertiary text-white dark:text-dark-text-primary px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Jumble
          </div>
        </NavLink>
      </div>
    </header>
  );
}
