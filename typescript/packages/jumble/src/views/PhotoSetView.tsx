import { useParams, useNavigate } from "react-router-dom";
import { getPhotoSetByName } from "@/utils/photoset";

export default function PhotoSetView() {
  const { photosetName } = useParams();
  const navigate = useNavigate();

  const photoset = getPhotoSetByName(photosetName || "");

  if (!photoset) {
    return (
      <div className="max-w-7xl mx-auto mt-10 p-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900">
            PhotoSet not found
          </h2>
          <p className="mt-2 text-gray-600">
            The photoset "{photosetName}" could not be found.
          </p>
          <button
            onClick={() => navigate("/")}
            className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto mt-10 p-6">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{photoset.name}</h1>
          <p className="text-gray-500 mt-1">
            Created on {new Date(photoset.createdAt).toLocaleDateString()}
          </p>
        </div>
        <button
          onClick={() => navigate(`/data/${photosetName}/spells/new`)}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center gap-2"
        >
          <span>Create Spell</span>
          <span className="text-lg">✨</span>
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {photoset.images.map(image => (
          <div
            key={image.id}
            className="aspect-square rounded-lg overflow-hidden shadow-md hover:shadow-lg transition-shadow"
          >
            <img
              src={image.dataUrl}
              alt={`Image in ${photoset.name}`}
              className="w-full h-full object-cover"
            />
          </div>
        ))}
      </div>

      {photoset.images.length === 0 && (
        <div className="text-center py-12">
          <p className="text-gray-500">No images in this photoset</p>
        </div>
      )}
    </div>
  );
}
