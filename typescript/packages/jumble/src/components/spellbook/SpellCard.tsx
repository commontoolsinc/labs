import { Link, useNavigate, useLocation } from "react-router-dom";

interface SpellCardProps {
  hash: string;
  name: string;
  author: string;
  likes: number;
  spellbookTitle: string;
  spellbookTags: string[];
  imageUrl: string;
}

export default function SpellCard({
  hash,
  name,
  author,
  likes,
  spellbookTitle,
  spellbookTags,
  imageUrl,
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
      <div className="relative aspect-video w-full border-b-2 border-black">
        <img src={imageUrl} alt={name} className="object-cover w-full h-full" />
      </div>
      <div className="p-4">
        <h2 className="text-xl font-bold text-black">{spellbookTitle}</h2>
        <h3 className="text-sm text-gray-600">({name})</h3>

        <p className="mt-2 text-sm text-black">by {author}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {spellbookTags.map((tag) => (
            <span
              key={tag}
              onClick={(e) => handleTagClick(e, tag)}
              className="
                text-sm bg-gray-100 px-2 py-1 border border-black
                hover:bg-gray-200 cursor-pointer transition-colors
              "
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}
