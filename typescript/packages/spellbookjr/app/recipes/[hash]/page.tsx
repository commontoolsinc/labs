import { getBlobByHash, getBlobScreenshotUrl } from "@/app/lib/blobby";
import Image from "next/image";
import dynamic from "next/dynamic";
import { notFound } from "next/navigation";

const ReactJson = dynamic(() => import("react-json-view"), { ssr: false });

interface RecipeDetailProps {
  params: { hash: string };
}

export default async function RecipeDetailPage({ params }: RecipeDetailProps) {
  const { hash } = params;

  let blob;
  try {
    blob = await getBlobByHash(hash);
  } catch (error) {
    notFound();
  }

  const screenshotUrl = getBlobScreenshotUrl(hash);

  return (
    <div>
      <h1>{blob.recipe.NAME || "Unnamed Recipe"}</h1>
      <Image
        src={screenshotUrl}
        alt="Recipe Screenshot"
        width={800}
        height={600}
      />
      <h2>Recipe JSON</h2>
      <ReactJson src={blob.recipe} collapsed={1} />
    </div>
  );
}
