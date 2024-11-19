"use client";

import Image from "next/image";
import JsonView from "@uiw/react-json-view";
import { LuHeart, LuShare, LuBookOpen, LuSend } from "react-icons/lu";
import Header from "@/app/components/header";
import { useState } from "react";

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
  const [showCopyMessage, setShowCopyMessage] = useState(false);

  const handleShare = () => {
    const url = `http://localhost:5173/recipes/${recipeHash}`;
    navigator.clipboard.writeText(url);
    setShowCopyMessage(true);
    setTimeout(() => setShowCopyMessage(false), 2000); // Hide after 2 seconds
  };

  console.log(recipe);
  return (
    <>
      <Header />
      <main className="min-h-screen bg-purple-50 p-4 md:p-8">
        <div className="container mx-auto max-w-4xl flex flex-col gap-4">
          <div className="actionBar bg-purple-100 rounded-2xl p-4 relative">
            <button
              onClick={handleShare}
              className="flex items-center gap-2 text-purple-600 hover:bg-purple-200 hover:text-purple-800 hover:-translate-y-0.5 hover:scale-105 active:translate-y-0 active:scale-95 p-4 rounded-2xl transition-all duration-150 ease-out"
            >
              <LuSend size={24} />
              <span>Share</span>
            </button>

            {showCopyMessage && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-4 py-2 bg-purple-900 text-white text-sm rounded-lg whitespace-nowrap animate-fade-in-down">
                Shareable recipe link copied to clipboard!
              </div>
            )}
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
                <div className="flex gap-4">
                  <button className="flex items-center text-purple-600 hover:text-purple-800 transition-colors">
                    <LuHeart className="w-5 h-5 mr-1" />
                    <span>{recipe.likes || 0}</span>
                  </button>
                  <button className="text-purple-600 hover:text-purple-800 transition-colors">
                    <LuShare className="w-5 h-5" />
                  </button>
                </div>
              </div>

              <div className="mb-8">
                <p className="text-gray-600">
                  by {recipe.blobAuthor || "Anonymous"}
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
