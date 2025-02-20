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
      className="group transform rounded-lg bg-white p-4 shadow-md transition-all hover:scale-105 hover:shadow-lg"
    >
      <div className="relative h-48 w-full overflow-hidden rounded-md">
        <img src={imageUrl} alt={name} className="object-cover" />
      </div>
      <div className="mt-4">
        <h2 className="mt-1 text-xl font-bold text-purple-900 group-hover:text-purple-600">
          {spellbookTitle}
        </h2>
        <h3 className="text-sm italic text-purple-900 group-hover:text-purple-600">({name})</h3>

        <p className="mt-1 text-sm text-gray-600">by {author}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          {spellbookTags.map((tag) => (
            <span
              key={tag}
              onClick={(e) => handleTagClick(e, tag)}
              className="text-sm text-purple-600 hover:text-purple-800 hover:underline cursor-pointer"
            >
              #{tag}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}
