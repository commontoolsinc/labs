import { useParams, useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { getPhotoSetByName, updatePhotoSet, deletePhotoSet } from "@/utils/photoset";

export default function PhotoSetView() {
  const { photosetName } = useParams();
  const navigate = useNavigate();
  const photoset = getPhotoSetByName(photosetName || "");

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "image/*": [".png", ".jpg", ".jpeg", ".gif"],
    },
    onDrop: async (acceptedFiles) => {
      if (!photoset) return;

      const newImages = await Promise.all(
        acceptedFiles.map(async (file) => {
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });

          return {
            id: crypto.randomUUID(),
            dataUrl,
            createdAt: new Date().toISOString(),
          };
        }),
      );

      const updatedPhotoset = {
        ...photoset,
        images: [...photoset.images, ...newImages],
      };
      updatePhotoSet(updatedPhotoset);
      window.location.reload();
    },
  });

  const handleDeleteImage = (imageId: string) => {
    if (!photoset) return;
    const updatedPhotoset = {
      ...photoset,
      images: photoset.images.filter((img) => img.id !== imageId),
    };
    updatePhotoSet(updatedPhotoset);
    window.location.reload();
  };

  const handleDeletePhotoset = () => {
    if (confirm("Are you sure you want to delete this photoset?")) {
      deletePhotoSet(photoset.id);
      navigate("/experiments/photoflow");
    }
  };

  if (!photoset) {
    return (
      <div className="max-w-7xl mx-auto mt-10 p-6">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900">PhotoSet not found</h2>
          <p className="mt-2 text-gray-600">The photoset "{photosetName}" could not be found.</p>
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
        <div className="flex gap-2">
          <button
            onClick={handleDeletePhotoset}
            className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
          >
            Delete PhotoSet
          </button>
          <button
            onClick={() => navigate(`/experiments/photoflow/${photosetName}/spells/new`)}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center gap-2"
          >
            <span>Create Spell</span>
            <span className="text-lg">✨</span>
          </button>
        </div>
      </div>

      <div className={`min-h-[400px] ${isDragActive ? "bg-blue-50" : ""} transition-colors`}>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {photoset.images.map((image) => (
            <div
              key={image.id}
              className="relative aspect-square rounded-lg shadow-md hover:shadow-lg transition-all transform hover:-translate-y-[1px] group"
            >
              <img
                src={image.dataUrl}
                alt={`Image in ${photoset.name}`}
                className="w-full h-full object-cover"
              />
              <button
                onClick={() => handleDeleteImage(image.id)}
                className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                ×
              </button>
            </div>
          ))}

          <div
            {...getRootProps()}
            className="aspect-square rounded-lg border-2 border-dashed border-gray-300 hover:border-gray-400 transition-colors flex items-center justify-center cursor-pointer"
          >
            <input {...getInputProps()} />
            <div className="text-4xl text-gray-400">+</div>
          </div>
        </div>
      </div>
    </div>
  );
}
