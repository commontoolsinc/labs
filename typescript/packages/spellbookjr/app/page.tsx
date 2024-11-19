import {
  getAllBlobs,
  getBlobByHash,
  getBlobScreenshotUrl,
} from "@/app/lib/blobby";
import { SearchBox } from "@/app/components/search-box";
import Header from "@/app/components/header";
import RecipeCard from "@/app/components/recipe-card";

interface BlobData {
  hash: string;
  name: string;
  author: string;
  likes: number;
}

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const searchTerm = searchParams.q?.toLowerCase() || "";

  const blobHashes = await getAllBlobs();
  const blobs = (
    await Promise.allSettled(
      blobHashes.map(async (hash) => {
        const blob = await getBlobByHash(hash);

        console.log(blob);
        return {
          hash,
          name: blob.recipeName || "Unnamed Recipe",
          author: blob.blobAuthor || "Anonymous",
          likes: blob.likes || 0,
        };
      }),
    )
  ).map((result) => (result.status === "fulfilled" ? result.value : null));

  const validBlobs = blobs.filter((blob): blob is BlobData => blob !== null);
  const filteredBlobs = validBlobs.filter((blob) =>
    blob?.name.toLowerCase().includes(searchTerm),
  );

  return (
    <>
      <Header />
      <main className="min-h-screen bg-purple-50">
        <div className="container mx-auto px-4 py-8">
          <div className="mb-8 flex items-center justify-between">
            <h1 className="text-4xl font-bold text-purple-900">Recipes</h1>
            <SearchBox defaultValue={searchTerm} />
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filteredBlobs.map((blob) => (
              <RecipeCard
                key={blob?.hash}
                hash={blob?.hash || ""}
                name={blob?.name}
                author={blob?.author || "Anonymous"}
                likes={blob?.likes || 0}
                imageUrl={getBlobScreenshotUrl(blob?.hash || "")}
              />
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
