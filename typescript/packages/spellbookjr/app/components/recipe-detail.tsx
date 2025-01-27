"use client";

import JsonView from "@uiw/react-json-view";
import { LuHeart, LuBookOpen, LuSend, LuCode } from "react-icons/lu";
import Header from "@/app/components/header";
import { useState } from "react";
import ActionButton from "@/app/components/action-button";

interface RecipeDetailProps {
  recipe: any;
  recipeHash: string;
  screenshotUrl: string;
}

export default function RecipeDetail({
  recipe,
  recipeHash,
  screenshotUrl,
}: RecipeDetailProps) {
  const [isLiked, setIsLiked] = useState(false);

  const handleShare = () => {
    const url = `http://localhost:5173/recipe/${recipeHash}`;
    navigator.clipboard.writeText(url);
  };

  const handleCopyBlobbyLink = () => {
    const url = `https://paas.saga-castor.ts.net/blobby/blob/${recipeHash}`;
    navigator.clipboard.writeText(url);
  };

  const handleLike = () => {
    setIsLiked(!isLiked);
    // TODO: Make API call to whatever service is handling likes
  };

  console.log(recipe);
  return (
    <>
      <Header />
      <main className="min-h-screen bg-purple-50 p-4 md:p-8">
        <div className="container mx-auto max-w-4xl flex flex-col gap-4">
          <div className="actionBar bg-purple-100 rounded-2xl p-4 flex gap-2 justify-between">
            <ActionButton
              icon={<LuCode size={24} />}
              label="Blobby"
              onClick={handleCopyBlobbyLink}
              popoverMessage="Blobby link copied to clipboard!"
            />
            <ActionButton
              icon={
                <LuHeart
                  size={24}
                  className={isLiked ? "fill-purple-600" : ""}
                />
              }
              label="Like"
              onClick={handleLike}
              popoverMessage="Liked!"
            />
            <ActionButton
              icon={<LuSend size={24} />}
              label="Share"
              onClick={handleShare}
              popoverMessage="Shareable recipe link copied to clipboard!"
            />
          </div>

          <div className="relative aspect-video w-full">
            <img
              src={screenshotUrl}
              alt={recipe.recipeName || "Recipe Screenshot"}
              className="rounded-2xl shadow-lg object-cover"
            />
          </div>

          <div className="bg-white rounded-xl shadow-lg overflow-hidden">
            <div className="p-4 md:p-8">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                <h1 className="text-2xl md:text-3xl font-bold text-purple-900">
                  {recipe.recipeName || "Unnamed Recipe"}
                </h1>
              </div>

              <div className="mb-8">
                <p className="text-gray-600">
                  first created by {recipe.blobAuthor || "Anonymous"}
                </p>
              </div>

              <div className="bg-purple-50 rounded-lg p-4 md:p-6">
                <div className="flex items-center mb-4">
                  <LuBookOpen className="w-5 h-5 text-purple-700 mr-2" />
                  <h2 className="text-lg md:text-xl font-semibold text-purple-900">
                    Recipe Details
                  </h2>
                </div>
                <JsonView
                  value={recipe}
                  style={{
                    background: "transparent",
                    fontSize: "0.875rem",
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
