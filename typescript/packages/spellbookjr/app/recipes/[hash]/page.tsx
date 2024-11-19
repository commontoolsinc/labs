import { getBlobByHash, getBlobScreenshotUrl } from "@/app/lib/blobby";
import { notFound } from "next/navigation";
import RecipeDetail from "@/app/components/recipe-detail";

interface RecipeDetailProps {
  params: { hash: string };
}

export default async function RecipeDetailPage({ params }: RecipeDetailProps) {
  const { hash } = await params;

  if (!hash) {
    notFound();
  }

  let blob;
  try {
    blob = await getBlobByHash(hash);
  } catch (error) {
    notFound();
  }

  const screenshotUrl = getBlobScreenshotUrl(hash);

  return (
    <RecipeDetail
      recipe={blob}
      recipeHash={hash}
      screenshotUrl={screenshotUrl}
    />
  );
}
