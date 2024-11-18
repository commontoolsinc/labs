"use client";

import Image from "next/image";
import JsonView from "@uiw/react-json-view";
import { LuHeart, LuShare, LuBookOpen } from "react-icons/lu";

interface RecipeDetailProps {
  recipe: any;
  screenshotUrl: string;
}

export default function RecipeDetail({
  recipe,
  screenshotUrl,
}: RecipeDetailProps) {
  return (
    <div className="min-h-screen bg-purple-50 px-4 py-8">
      <div className="container mx-auto max-w-4xl">
        <div className="overflow-hidden rounded-xl bg-white shadow-lg">
          <div className="relative h-[400px] w-full">
            <img
              src={screenshotUrl}
              alt={recipe.recipeName || "Recipe Screenshot"}
              fill
              className="object-cover"
            />
          </div>

          <div className="p-8">
            <div className="mb-6 flex items-center justify-between">
              <h1 className="text-3xl font-bold text-purple-900">
                {recipe.recipeName || "Unnamed Recipe"}
              </h1>
              <div className="flex gap-4">
                <button className="flex items-center text-purple-600 hover:text-purple-800">
                  <LuHeart className="mr-1 h-5 w-5" />
                  <span>{recipe.likes || 0}</span>
                </button>
                <button className="text-purple-600 hover:text-purple-800">
                  <LuShare className="h-5 w-5" />
                </button>
              </div>
            </div>

            <div className="mb-8">
              <p className="text-gray-600">by {recipe.author || "Anonymous"}</p>
            </div>

            <div className="rounded-lg bg-purple-50 p-6">
              <div className="mb-4 flex items-center">
                <LuBookOpen className="mr-2 h-5 w-5 text-purple-700" />
                <h2 className="text-xl font-semibold text-purple-900">
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
    </div>
  );
}
