import {
  getAllBlobs,
  getBlobByHash,
  getBlobScreenshotUrl,
} from "@/app/lib/blobby";
import Link from "next/link";
import { SearchBox } from "@/app/components/search-box";
import { LuHeart } from "react-icons/lu";
import Image from "next/image";

interface BlobData {
  hash: string;
  name: string;
  author?: string;
  likes?: number;
}

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: { q?: string } | Promise<{ q?: string }>;
}) {
  const resolvedParams = await searchParams;
  const searchTerm = resolvedParams.q?.toLowerCase() || "";

  const blobHashes = await getAllBlobs();
  const blobs = await Promise.all(
    blobHashes.map(async (hash) => {
      try {
        const blob = await getBlobByHash(hash);
        return {
          hash,
          name: blob.recipeName || "Unnamed Recipe",
          author: blob.author || "Anonymous",
          likes: blob.likes || 0,
        };
      } catch {
        return null;
      }
    }),
  );

  const validBlobs = blobs.filter((blob): blob is BlobData => blob !== null);
  const filteredBlobs = validBlobs.filter((blob) =>
    blob.name.toLowerCase().includes(searchTerm),
  );

  return (
    <div className="min-h-screen bg-purple-50">
      <div className="container mx-auto px-4 py-8">
        <div className="mb-8 flex items-center justify-between">
          <a href="/">
            <img src="/images/logo.svg" alt="Spellbook Jr." className="w-40" />
          </a>
          <SearchBox defaultValue={searchTerm} />
        </div>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filteredBlobs.map(({ hash, name, author, likes }) => (
            <Link
              key={hash}
              href={`/recipes/${hash}`}
              className="group transform rounded-lg bg-white p-4 shadow-md transition-all hover:scale-105 hover:shadow-lg"
            >
              <div className="relative h-48 w-full overflow-hidden rounded-md">
                <img
                  src={getBlobScreenshotUrl(hash)}
                  alt={name}
                  fill
                  className="object-cover"
                />
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
          ))}
        </div>
      </div>
    </div>
  );
}
