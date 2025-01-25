import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { savePhotoSet } from "@/utils/photoset";

export default function NewPhotoSet() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [images, setImages] = useState<Array<{ id: string; dataUrl: string }>>(
    [],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      "image/*": [".png", ".jpg", ".jpeg", ".gif"],
    },
    onDrop: async acceptedFiles => {
      const newImages = await Promise.all(
        acceptedFiles.map(async file => {
          const dataUrl = await new Promise<string>(resolve => {
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

      setImages(current => [...current, ...newImages]);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    const photoset = {
      id: crypto.randomUUID(),
      name: name.trim(),
      images,
      createdAt: new Date().toISOString(),
    };

    savePhotoSet(photoset);
    navigate(`/data/${photoset.name}`);
  };

  return (
    <div className="max-w-xl mx-auto mt-10 p-6">
      <h1 className="text-2xl font-bold mb-6">Create New PhotoSet</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            PhotoSet Name
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
          />
          {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
        </div>

        <div
          {...getRootProps()}
          className={`mt-4 p-6 border-2 border-dashed rounded-lg text-center cursor-pointer
            ${isDragActive ? "border-blue-500 bg-blue-50" : "border-gray-300 hover:border-gray-400"}`}
        >
          <input {...getInputProps()} />
          {isDragActive ? (
            <p className="text-blue-500">Drop the images here...</p>
          ) : (
            <p className="text-gray-500">
              Drag & drop images here, or click to select files
            </p>
          )}
        </div>

        {images.length > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-4">
            {images.map(image => (
              <div key={image.id} className="relative aspect-square">
                <img
                  src={image.dataUrl}
                  alt="Preview"
                  className="w-full h-full object-cover rounded-lg"
                />
                <button
                  type="button"
                  onClick={() =>
                    setImages(current =>
                      current.filter(img => img.id !== image.id),
                    )
                  }
                  className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="submit"
          className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
        >
          Create PhotoSet
        </button>
      </form>
    </div>
  );
}
