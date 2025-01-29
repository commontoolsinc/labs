"use client";

import Image from "next/image";
import Link from "next/link";
import { LuHeart } from "react-icons/lu";
import { useRouter, usePathname, useSearchParams } from "next/navigation";

interface RecipeCardProps {
  hash: string;
  name: string;
  author: string;
  likes: number;
  spellbookTitle: string;
  spellbookTags: string[];
  imageUrl: string;
}

export default function RecipeCard({
  hash,
  name,
  author,
  likes,
  spellbookTitle,
  spellbookTags,
  imageUrl,
}: RecipeCardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const handleTagClick = (e: React.MouseEvent<HTMLSpanElement>, tag: string) => {
    e.preventDefault();
    const params = new URLSearchParams(searchParams);
    params.set("q", tag);
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <Link
      href={`/recipes/${hash}`}
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
        {/* TODO(jake): Add likes back in once we have some form of identity */}
        {/* <div className="mt-2 flex items-center text-purple-400">
          <LuHeart className="mr-1 h-4 w-4" />
          <span className="text-sm">{likes}</span>
        </div> */}
      </div>
    </Link>
  );
}
