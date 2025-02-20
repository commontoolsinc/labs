import { useLocation, useNavigate } from "react-router-dom";
import { useTransition } from "react";

interface SearchBoxProps {
  defaultValue?: string;
}

export function SearchBox({ defaultValue = "" }: SearchBoxProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [isPending, startTransition] = useTransition();

  const handleSearch = (term: string) => {
    const params = new URLSearchParams(location.search);
    if (term) {
      params.set("q", term);
    } else {
      params.delete("q");
    }

    startTransition(() => {
      navigate(`${location.pathname}?${params.toString()}`);
    });
  };

  return (
    <div className="flex items-center">
      <input
        type="text"
        defaultValue={defaultValue}
        onChange={(e) => handleSearch(e.target.value)}
        placeholder="Search spells"
        className={`text-black border-2 border-purple-900 rounded-full px-2 py-1 ${
          isPending ? "opacity-50" : ""
        }`}
      />
    </div>
  );
}
