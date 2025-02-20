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
        className={`
          w-full px-3 py-2 bg-white
          border-2 border-black
          shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
          focus:outline-none focus:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)]
          placeholder:text-gray-500
          ${isPending ? "opacity-50" : ""}
        `}
      />
    </div>
  );
}
