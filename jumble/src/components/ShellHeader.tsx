import { NavLink } from "react-router-dom";
import ShapeLogo from "@/assets/ShapeLogo.tsx";
import { NavPath } from "@/components/NavPath.tsx";
import { User } from "@/components/User.tsx";
import { useNamedCell } from "@/hooks/use-cell.ts";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { useTheme } from "@/contexts/ThemeContext.tsx";

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
  const colorSpace = session.space;
  const { isDarkMode } = useTheme();

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

  // Adjust the background color opacity based on theme
  const getBackgroundColor = () => {
    if (!style?.color || style.color === "transparent") return undefined;

    // Convert hex to rgba with appropriate opacity for dark mode
    if (isDarkMode && style.color.startsWith("#")) {
      const hex = style.color.slice(1);
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, 0.75)`;
    }

    return style.color;
  };

  return (
    <header
      className="flex bg-gray-50 dark:bg-dark-bg-secondary items-center justify-between border-b-2 border-gray-200 dark:border-dark-border p-2 transition-colors duration-200"
      style={{ backgroundColor: getBackgroundColor() }}
      onClick={handleHeaderClick}
    >
      <div className="header-start flex items-center gap-2">
        <NavLink
          to={`/${session.name}`}
          className="brand flex items-center gap-2 transition-opacity duration-200 hover:opacity-80"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor={isDarkMode ? "#fff" : "#000"}
            containerColor={isDarkMode ? "#4a4a4a" : "#d2d2d2"}
          />
        </NavLink>
        <NavPath replicaId={session.name} charmId={charmId} />
      </div>
      <div className="header-end flex items-center gap-2">
        <User />

        <ThemeToggle />

        <NavLink
          to="/spellbook"
          className="brand flex items-center gap-2 opacity-30 hover:opacity-100 transition-opacity duration-200 relative group cursor-pointer z-10"
        >
          <ShapeLogo
            width={32}
            height={32}
            shapeColor={isDarkMode ? "#B77EEA" : "#7F08EA"}
            containerColor={isDarkMode ? "#8A4EC0" : "#B77EEA"}
          />
          <div className="absolute top-10 left-1/2 -translate-x-2/3 bg-gray-800 dark:bg-dark-bg-tertiary text-white dark:text-dark-text-primary px-2 py-1 rounded text-sm opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
            Spellbook
          </div>
        </NavLink>
      </div>
    </header>
  );
}

export default ShellHeader;
