import { WebComponent } from "@/components/WebComponent.tsx";
import { SpellSearchResult } from "@/search.ts";
import { useCallback } from "react";

interface SearchResultsProps {
  searchOpen: boolean;
  results: SpellSearchResult[];
  onClose: () => void;
  onSpellCast: (spell: SpellSearchResult, blob: SpellSearchResult["compatibleBlobs"][0]) => void;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffInMillis = now.getTime() - date.getTime();
  const diffInMinutes = Math.floor(diffInMillis / (1000 * 60));
  const diffInHours = Math.floor(diffInMillis / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMillis / (1000 * 60 * 60 * 24));

  if (diffInMinutes < 1) {
    return "just now";
  }
  if (diffInMinutes < 60) {
    return `${diffInMinutes} minute${diffInMinutes === 1 ? "" : "s"} ago`;
  }
  if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours === 1 ? "" : "s"} ago`;
  }
  if (diffInDays < 30) {
    return `${diffInDays} day${diffInDays === 1 ? "" : "s"} ago`;
  }

  return date.toLocaleDateString();
}
export default function SearchResults({
  searchOpen,
  results,
  onClose,
  onSpellCast,
}: SearchResultsProps) {
  const handleSpellCast = useCallback(
    (result: SpellSearchResult, blob: SpellSearchResult["compatibleBlobs"][0]) => {
      onSpellCast(result, blob);
    },
    [onSpellCast],
  );

  return (
    <WebComponent as="os-dialog" open={searchOpen} onClosedialog={onClose}>
      <div className="max-h-[50vh] overflow-y-auto">
        {results.map((result) => (
          <div key={result.key}>
            <div className="mt-4">
              {result.compatibleBlobs.map((blob) => (
                <WebComponent
                  key={blob.key}
                  as="os-charm-row"
                  icon="search"
                  text={result.description}
                  subtitle={`${blob.key}, ${formatRelativeTime(blob.data.blobCreatedAt)}`}
                  onClick={() => handleSpellCast(result, blob)}
                  className="p-2 rounded cursor-pointer hover:bg-gray-100"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </WebComponent>
  );
}
