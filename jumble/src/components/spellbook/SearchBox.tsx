import { useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState, useTransition } from "react";
import { useDebounce } from "@/hooks/use-debounce.ts";

interface SearchBoxProps {
  defaultValue?: string;
}

export function SearchBox({ defaultValue = "" }: SearchBoxProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [isPending, startTransition] = useTransition();
  const [searchTerm, setSearchTerm] = useState(defaultValue);
  const debouncedSearchTerm = useDebounce(searchTerm, 500); // 300ms delay

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (debouncedSearchTerm) {
      params.set("q", debouncedSearchTerm);
    } else {
      params.delete("q");
    }

    startTransition(() => {
      navigate(`${location.pathname}?${params.toString()}`);
    });
  }, [debouncedSearchTerm, location.pathname, navigate]);

  return (
    <div className="flex items-center">
      <input
        type="text"
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        placeholder="Search spells"
        className={`
          w-full px-3 py-2 bg-white dark:bg-dark-bg-tertiary dark:text-white
          border-2 border-black dark:border-gray-600
          shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[2px_2px_0px_0px_rgba(80,80,80,0.5)]
          focus:outline-none focus:shadow-[2px_2px_0px_0px_rgba(0,0,0,0.7)] dark:focus:shadow-[2px_2px_0px_0px_rgba(100,100,100,0.6)]
          placeholder:text-gray-500 dark:placeholder:text-gray-400
          ${isPending ? "opacity-50" : ""}
        `}
      />
    </div>
  );
}
