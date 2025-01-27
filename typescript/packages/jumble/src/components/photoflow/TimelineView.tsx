import { type PhotoSetImage } from "@/types/photoflow";

interface TimelineViewProps {
  images: PhotoSetImage[];
}

export function TimelineView({ images }: TimelineViewProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <div className="space-y-16 py-8">
        {images.map((image) => (
          <div key={image.id} className="flex flex-col items-center">
            <div className="w-full rounded-lg overflow-hidden shadow-lg bg-white">
              <img
                src={image.dataUrl}
                alt=""
                className="w-full h-auto object-cover"
                loading="lazy"
              />
            </div>
            <div className="mt-4 text-sm text-gray-500">
              {new Date(image.createdAt).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
