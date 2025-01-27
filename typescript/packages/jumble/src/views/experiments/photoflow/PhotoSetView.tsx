import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useDropzone } from "react-dropzone";
import { getPhotoSetByName, updatePhotoSet, deletePhotoSet } from "@/utils/photoset";
import Header from "@/components/photoflow/Header";
import ViewToggle from "@/components/photoflow/ViewToggle";
import type { ViewType } from "@/types/photoflow";
import Scratchpad from "@/components/photoflow/Scratchpad";
import { TimelineView } from "@/components/photoflow/TimelineView";

export default function PhotoSetView() {
  const { photosetName } = useParams();
  const navigate = useNavigate();
  const photoset = getPhotoSetByName(photosetName || "");
  const [view, setView] = useState<ViewType>("grid");
  const [isScratchpadOpen, setIsScratchpadOpen] = useState(false);
  const [timelineUnlocked, setTimelineUnlocked] = useState(false);

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

  const handleViewChange = (newView: ViewType) => {
    setView(newView);
  };

  const renderGridView = () => (
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
  );

  const renderTableView = () => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b">
            <th className="text-left py-3 px-4">Preview</th>
            <th className="text-left py-3 px-4">Created</th>
            <th className="text-left py-3 px-4">Size</th>
            <th className="py-3 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {photoset.images.map((image) => (
            <tr key={image.id} className="border-b hover:bg-gray-50 group">
              <td className="py-3 px-4">
                <div className="w-20 h-20 rounded overflow-hidden bg-gray-100">
                  <img src={image.dataUrl} alt="" className="w-full h-full object-cover" />
                </div>
              </td>
              <td className="py-3 px-4 text-gray-600">
                {new Date(image.createdAt).toLocaleDateString()}
              </td>
              <td className="py-3 px-4 text-gray-600">
                {(image.dataUrl.length / 1024).toFixed(1)} KB
              </td>
              <td className="py-3 px-4">
                <button
                  onClick={() => handleDeleteImage(image.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={4} className="py-3 px-4">
              <div
                {...getRootProps()}
                className="border-2 border-dashed border-gray-300 hover:border-gray-400 transition-colors rounded-lg py-4 text-center cursor-pointer"
              >
                <input {...getInputProps()} />
                <div className="text-gray-500">Drop images here, or click to select files</div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  if (!photoset) {
    return (
      <>
        <Header />
        <div className="max-w-7xl mx-auto mt-10 p-6">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-gray-900">PhotoSet not found</h2>
            <p className="mt-2 text-gray-600">The photoset "{photosetName}" could not be found.</p>
            <button
              onClick={() => navigate("/experiments/photoflow")}
              className="mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Back to PhotoFlow
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Header onOpenScratchpad={() => setIsScratchpadOpen(true)} />
      <div className="max-w-7xl mx-auto mt-10 p-6">
        <div className="flex justify-between items-center mb-8">
          <div>
            <h2 className="text-5xl font-black text-gray-900">{photoset.name}</h2>
            <p className="text-gray-500 mt-1">
              Created on {new Date(photoset.createdAt).toLocaleDateString()}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <ViewToggle view={view} setView={setView} showTimeline={timelineUnlocked} />
          </div>
        </div>

        <div className={`min-h-[400px] ${isDragActive ? "bg-blue-50" : ""} transition-colors`}>
          {view === "grid" ? (
            renderGridView()
          ) : view === "table" ? (
            renderTableView()
          ) : (
            <TimelineView images={photoset.images} />
          )}
        </div>

        {photoset.images.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">
              {isDragActive
                ? "Drop images here..."
                : "Drag & drop images here, or click to select files"}
            </p>
          </div>
        )}
      </div>
      <Scratchpad
        isOpen={isScratchpadOpen}
        onClose={() => setIsScratchpadOpen(false)}
        photosetName={photoset.name}
        onViewChange={handleViewChange}
        onUnlockTimelineView={() => setTimelineUnlocked(true)}
      />
    </>
  );
}
