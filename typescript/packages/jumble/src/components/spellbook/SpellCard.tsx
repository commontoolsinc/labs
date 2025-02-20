import { Link, useNavigate, useLocation } from "react-router-dom";
import { SpellPreview } from "@/components/spellbook/SpellPreview";
import { LuHeart, LuMessageSquare, LuSend } from "react-icons/lu";

interface SpellCardProps {
  hash: string;
  title: string;
  tags: string[];
  ui: any;
  likes: number;
  comments: number;
}

export default function SpellCard({ hash, title, tags, ui, likes, comments }: SpellCardProps) {
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
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-black">{title}</h2>
          <div className="flex gap-1">
            {tags.slice(0, 3).map((tag) => (
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

        <div className="mt-4 flex items-center justify-between w-full text-sm text-gray-600">
          <div className="relative group">
            <div className="flex items-center gap-1 cursor-pointer">
              <LuHeart className="w-4 h-4" />
              <span>{likes}</span>
            </div>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black text-white px-2 py-1 text-sm border border-white pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {likes} likes
            </div>
          </div>
          <div className="relative group">
            <div className="flex items-center gap-1 cursor-pointer">
              <LuMessageSquare className="w-4 h-4" />
              <span>{comments}</span>
            </div>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black text-white px-2 py-1 text-sm border border-white pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {comments} comments
            </div>
          </div>
          <div className="relative group">
            <div className="flex items-center gap-1 cursor-pointer">
              <LuSend className="w-4 h-4" />
              <span>7</span>
            </div>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black text-white px-2 py-1 text-sm border border-white pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              7 shares
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
