import { Link, useNavigate, useLocation } from "react-router-dom";
import { SpellPreview } from "@/components/spellbook/SpellPreview";

interface SpellCardProps {
  hash: string;
  title: string;
  tags: string[];
  ui: any;
  description: string;
  publishedAt: string;
  author: string;
  data: any;
}

export default function SpellCard({
  hash,
  title,
  tags,
  description,
  publishedAt,
  author,
  ui,
}: SpellCardProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleTagClick = (e: React.MouseEvent<HTMLSpanElement>, tag: string) => {
    e.preventDefault();
    const searchParams = new URLSearchParams(location.search);
    searchParams.set("q", tag);
    navigate(`${location.pathname}?${searchParams.toString()}`);
  };

  return (
    <Link
      to={`/spellbook/${hash}`}
      className="
        block bg-white border-2 border-black 
        shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]
        hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)]
        transition-[transform,shadow] duration-100 ease-in-out
      "
    >
      <div className="relative aspect-video w-full border-b-2 border-black overflow-hidden">
        <SpellPreview ui={ui} />
      </div>
      <div className="p-4">
        <h2 className="text-xl font-bold text-black">{title}</h2>

        <p className="mt-2 text-sm text-black">by {author}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              onClick={(e) => handleTagClick(e, tag)}
              className="
                text-sm bg-gray-100 px-2 py-1 border border-black
                hover:bg-gray-200 cursor-pointer transition-colors
              "
            >
              {tag}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}
