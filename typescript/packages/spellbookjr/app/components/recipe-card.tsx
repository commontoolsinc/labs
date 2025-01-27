"use client";

import Image from "next/image";
import Link from "next/link";
import { LuHeart } from "react-icons/lu";

interface RecipeCardProps {
  hash: string;
  name: string;
  author: string;
  likes: number;
  imageUrl: string;
}

export default function RecipeCard({
  hash,
  name,
  author,
  likes,
  imageUrl,
}: RecipeCardProps) {
  return (
    <Link
      href={`/recipes/${hash}`}
      className="group transform rounded-lg bg-white p-4 shadow-md transition-all hover:scale-105 hover:shadow-lg"
    >
      <div className="relative h-48 w-full overflow-hidden rounded-md">
        <img src={imageUrl} alt={name} className="object-cover" />
      </div>
      <div className="mt-4">
        <h2 className="text-xl font-semibold text-purple-900 group-hover:text-purple-600">
          {name}
        </h2>
        <p className="mt-1 text-sm text-gray-600">by {author}</p>
        <div className="mt-2 flex items-center text-purple-400">
          <LuHeart className="mr-1 h-4 w-4" />
          <span className="text-sm">{likes}</span>
        </div>
      </div>
    </Link>
  );
}
