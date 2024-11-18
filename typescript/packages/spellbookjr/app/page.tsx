import { getAllBlobs, getBlobByHash } from "@/app/lib/blobby";
import Link from "next/link";
import { SearchBox } from "@/app/components/search-box";

interface BlobData {
  hash: string;
  name: string;
}

export default async function RecipesPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const blobHashes = await getAllBlobs();
  console.log("Got blob hashes:", blobHashes);

  const blobs = await Promise.all(
    blobHashes.map(async (hash) => {
      try {
        const blob = await getBlobByHash(hash);

        console.log("Got blob:", blob);
        return {
          hash,
          // FIXME(jake): This is a hack to get the recipe name. For now this just
          // uses the schema description, but we will swap to recipe name once it
          // is added to the blob.
          name: blob?.recipeName || "Unnamed Recipe",
        };
      } catch (error) {
        console.error(`Failed to fetch blob ${hash}:`, error);
        return {
          hash,
          name: `Failed to load (${hash.slice(0, 8)}...)`,
        };
      }
    }),
  );

  const searchTerm = searchParams.q?.toLowerCase() || "";
  const filteredBlobs = blobs.filter((blob) =>
    blob.name.toLowerCase().includes(searchTerm),
  );

  return (
    <div>
      <h1>All Recipes</h1>
      <SearchBox defaultValue={searchTerm} />
      <ul>
        {filteredBlobs.map(({ hash, name }) => (
          <li key={hash}>
            <Link href={`/recipes/${hash}`}>{name}</Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
