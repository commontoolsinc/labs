import { getBlobByHash, getBlobScreenshotUrl } from "@/app/lib/blobby";
import { notFound } from "next/navigation";
import RecipeDetail from "@/app/components/recipe-detail";
import JsonView from "@uiw/react-json-view";
interface RecipeDetailProps {
  params: { hash: string };
}

export default async function RecipeDetailPage({ params }: RecipeDetailProps) {
  const hash = params.hash as string;

  let blob;
  try {
    blob = await getBlobByHash(hash);
  } catch (error) {
    notFound();
  }

  const screenshotUrl = getBlobScreenshotUrl(hash);

  return <RecipeDetail recipe={blob} screenshotUrl={screenshotUrl} />;
}
