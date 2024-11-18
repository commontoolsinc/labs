"use client";

import Image from "next/image";
import JsonView from "@uiw/react-json-view";

interface RecipeDetailProps {
  recipe: any; // TODO: type this properly based on your recipe structure
  screenshotUrl: string;
}

export default function RecipeDetail({
  recipe,
  screenshotUrl,
}: RecipeDetailProps) {
  return (
    <div>
      <h1>{recipe.recipeName || "Unnamed Recipe"}</h1>
      <img
        src={screenshotUrl}
        alt="Recipe Screenshot"
        width={800}
        height={600}
      />
      <h2>Recipe JSON</h2>
      <JsonView value={recipe} />
    </div>
  );
}
