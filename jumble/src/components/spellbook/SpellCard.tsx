import { Link, useLocation, useNavigate } from "react-router-dom";
import { SpellPreview } from "@/components/spellbook/SpellPreview.tsx";
import { LuHeart, LuMessageSquare, LuSend } from "react-icons/lu";

interface SpellCardProps {
  spellId: string;
  title: string;
  tags: string[];
  ui: any;
  likes: number;
  comments: number;
  shares: number;
}

export default function SpellCard({
  spellId,
  title,
  tags,
  ui,
  likes,
  comments,
  shares,
}: SpellCardProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleTagClick = (
    e: React.MouseEvent<HTMLSpanElement>,
    tag: string,
  ) => {
    e.preventDefault();
    const searchParams = new URLSearchParams(location.search);
    searchParams.set("q", tag);
    navigate(`${location.pathname}?${searchParams.toString()}`);
  };

  return (
    <Link
      to={`/spellbook/${spellId}`}
      className="
        block bg-white dark:bg-dark-bg-secondary border-2 border-black dark:border-gray-600
        shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)] dark:shadow-[2px_2px_0px_0px_rgba(80,80,80,0.5)]
        hover:translate-y-[-2px] hover:shadow-[2px_4px_0px_0px_rgba(0,0,0,0.7)] dark:hover:shadow-[2px_4px_0px_0px_rgba(100,100,100,0.6)]
        transition-[transform,shadow] duration-100 ease-in-out
        relative
      "
    >
      <div className="relative aspect-video w-full border-b-2 border-black dark:border-gray-600 overflow-hidden pointer-events-none select-none">
        <SpellPreview ui={ui} />
      </div>
      <div className="p-4">
        <h2 className="text-xl font-bold text-black dark:text-white mb-2">
          {title}
        </h2>
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              onClick={(e) => handleTagClick(e, tag)}
              className="
                text-sm bg-gray-100 dark:bg-dark-bg-tertiary px-2 py-1 border border-black dark:border-gray-600
                dark:text-dark-text-primary hover:bg-gray-200 dark:hover:bg-dark-bg-primary cursor-pointer transition-colors
                relative z-10
              "
            >
              {tag}
            </span>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between w-full text-sm text-gray-600 dark:text-gray-400 pointer-events-none select-none">
          <div className="relative group">
            <div className="flex items-center gap-1 cursor-pointer">
              <LuHeart className="w-4 h-4" />
              <span>{likes}</span>
            </div>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black dark:bg-dark-bg-tertiary text-white px-2 py-1 text-sm border border-white dark:border-gray-600 pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {likes} {likes === 1 ? "like" : "likes"}
            </div>
          </div>
          <div className="relative group">
            <div className="flex items-center gap-1 cursor-pointer">
              <LuMessageSquare className="w-4 h-4" />
              <span>{comments}</span>
            </div>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black dark:bg-dark-bg-tertiary text-white px-2 py-1 text-sm border border-white dark:border-gray-600 pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {comments} {comments === 1 ? "comment" : "comments"}
            </div>
          </div>
          <div className="relative group">
            <div className="flex items-center gap-1 cursor-pointer">
              <LuSend className="w-4 h-4" />
              <span>{shares}</span>
            </div>
            <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black dark:bg-dark-bg-tertiary text-white px-2 py-1 text-sm border border-white dark:border-gray-600 pointer-events-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {shares} {shares === 1 ? "share" : "shares"}
            </div>
          </div>
        </div>
      </div>
    </Link>
  );
}
