import React, { useEffect, useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { NAME } from "@commontools/builder";
import { Cell } from "@commontools/runner";
import { Charm } from "@commontools/charm";
import { charmId } from "@commontools/charm";
import { createPath } from "@/routes.ts";
import { type CharmRouteParams } from "@/routes.ts";
import { useCharmManager } from "@/contexts/CharmManagerContext.tsx";
import { useCell } from "@/hooks/use-cell.ts";
import { HoverPreview } from "@/components/HoverPreview.tsx";
import { useCharmHover } from "@/hooks/use-charm-hover.ts";

export interface CharmLinkProps {
  charm: Cell<Charm> | any;
  replicaName?: string;
  showId?: boolean;
  showHash?: boolean;
  showHoverPreview?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * A component for rendering a consistent link to a charm
 *
 * @param charm - The charm cell or object with an entity ID
 * @param replicaName - Optional: The replica name for routing (defaults to current URL replica)
 * @param showId - Whether to show the full ID (defaults to false)
 * @param showHash - Whether to show the shortened hash (defaults to true)
 * @param showHoverPreview - Whether to show hover preview (defaults to true)
 * @param className - Additional className for the link
 * @param children - Optional children to render inside the link instead of the charm name
 */
export const CharmLink: React.FC<CharmLinkProps> = ({
  charm,
  replicaName,
  showId = false,
  showHash = true,
  showHoverPreview = true,
  className = "",
  children,
}) => {
  const params = useParams<CharmRouteParams>();
  const currentReplicaName = replicaName || params.replicaName;
  const [charmName, setCharmName] = useState<string | null>(null);
  const id = charmId(charm);

  const { hoveredCharm, previewPosition, handleMouseMove, handleMouseLeave } =
    useCharmHover();

  const { charmManager } = useCharmManager();
  const [charms] = useCell(charmManager.getCharms());
  const instance = charms?.find((c) => charmId(c) === id);
  const isHovered = hoveredCharm === id;

  // If charm is a Cell<Charm>, get its name
  useEffect(() => {
    if (!charm) return;

    let cancel: (() => void) | undefined;
    let mounted = true;

    try {
      // If charm is a Cell with NAME key, subscribe to changes
      if (charm.key && typeof charm.key === "function") {
        cancel = charm.key(NAME)?.sink((value: string | null) => {
          if (mounted) setCharmName(value || "Unnamed Charm");
        });
      } else if (charm.get && typeof charm.get === "function") {
        // If charm is a Cell but doesn't expose key directly
        const data = charm.get();
        setCharmName(data?.[NAME] || "Unnamed Charm");
      }
    } catch (e) {
      console.error("Error getting charm name:", e);
      setCharmName("Unnamed Charm");
    }

    return () => {
      mounted = false;
      cancel?.();
    };
  }, [charm]);

  if (!id || !currentReplicaName) return null;

  // Generate the display text based on props
  const displayText = () => {
    if (children) return children;

    const text = charmName || "Unnamed Charm";

    if (showId) {
      return text + ` (${id})`;
    }

    if (showHash) {
      return text + ` (#${id.slice(-4)})`;
    }

    return text;
  };

  return (
    <div className="relative inline-block">
      <NavLink
        to={createPath("charmShow", {
          charmId: id,
          replicaName: currentReplicaName,
        })}
        aria-roledescription="charm-link"
        className={({ isActive }) => `
          charm-link font-medium transition-colors
          hover:text-black hover:underline
          ${isActive ? "text-black" : "text-gray-700"}
          ${className}
        `}
        onMouseMove={(e) =>
          showHoverPreview ? handleMouseMove(e, id) : undefined}
        onMouseLeave={showHoverPreview ? handleMouseLeave : undefined}
      >
        {displayText()}
      </NavLink>

      {showHoverPreview && isHovered && instance && (
        <HoverPreview
          charm={instance}
          position={previewPosition}
        />
      )}
    </div>
  );
};

export default CharmLink;
