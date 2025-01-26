import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getPhotoSets, savePhotoSet, deletePhotoSet } from "@/utils/photoset";
import Header from "@/components/photoflow/Header";
import ViewToggle from "@/components/photoflow/ViewToggle";
import type { ViewType } from "@/types/photoflow";

export default function PhotoFlowIndex() {
  const navigate = useNavigate();
  const photosets = getPhotoSets();
  const [view, setView] = useState<ViewType>("grid");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newSetName, setNewSetName] = useState("");

  const handleCreatePhotoset = () => {
    if (!newSetName.trim()) return;

    const photoset = {
      id: crypto.randomUUID(),
      name: newSetName.trim(),
      images: [],
      createdAt: new Date().toISOString(),
    };

    savePhotoSet(photoset);
    navigate(`/experiments/photoflow/${photoset.name}`);
  };

  const handleDeletePhotoset = (e: React.MouseEvent, id: string) => {
    e.stopPropagation(); // Prevent navigation when clicking delete
    if (confirm("Are you sure you want to delete this photoset?")) {
      deletePhotoSet(id);
      window.location.reload();
    }
  };

  const renderGridView = () => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {photosets.map((photoset) => (
        <div
          key={photoset.id}
          onClick={() => navigate(`/experiments/photoflow/${photoset.name}`)}
          className="group relative cursor-pointer"
        >
          {/* Stacked background cards for depth effect */}
          <div className="absolute -bottom-2 -right-2 w-full h-full bg-white border rounded-lg rotate-3"></div>
          <div className="absolute -bottom-1 -right-1 w-full h-full bg-white border rounded-lg rotate-1"></div>

          {/* Main polaroid card */}
          <div className="relative bg-white border rounded-lg p-3 shadow-md hover:shadow-lg transition-all transform hover:-translate-y-1">
            {/* Image preview area */}
            <div className="aspect-[4/3] mb-4 bg-gray-100 rounded overflow-hidden">
              {photoset.images.length > 0 ? (
                <img
                  src={photoset.images[0].dataUrl}
                  alt={`Preview of ${photoset.name}`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  No images
                </div>
              )}
            </div>

            {/* Polaroid bottom */}
            <div className="px-2">
              <h2 className="text-xl font-semibold text-gray-900 truncate">{photoset.name}</h2>
              <p className="text-sm text-gray-500">
                {photoset.images.length} image{photoset.images.length !== 1 ? "s" : ""}
              </p>
              <p className="text-xs text-gray-400">
                {new Date(photoset.createdAt).toLocaleDateString()}
              </p>
            </div>

            {/* Delete button */}
            <button
              onClick={(e) => handleDeletePhotoset(e, photoset.id)}
              className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity z-10"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  const renderTableView = () => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b">
            <th className="text-left py-3 px-4">Name</th>
            <th className="text-left py-3 px-4">Images</th>
            <th className="text-left py-3 px-4">Created</th>
            <th className="py-3 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {photosets.map((photoset) => (
            <tr
              key={photoset.id}
              onClick={() => navigate(`/experiments/photoflow/${photoset.name}`)}
              className="border-b hover:bg-gray-50 cursor-pointer group"
            >
              <td className="py-3 px-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded overflow-hidden bg-gray-100">
                    {photoset.images[0] && (
                      <img
                        src={photoset.images[0].dataUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <span className="font-medium">{photoset.name}</span>
                </div>
              </td>
              <td className="py-3 px-4 text-gray-600">
                {photoset.images.length} image{photoset.images.length !== 1 ? "s" : ""}
              </td>
              <td className="py-3 px-4 text-gray-600">
                {new Date(photoset.createdAt).toLocaleDateString()}
              </td>
              <td className="py-3 px-4">
                <button
                  onClick={(e) => handleDeletePhotoset(e, photoset.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600"
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <Header setIsCreateModalOpen={setIsCreateModalOpen} />
      <div className="max-w-7xl mx-auto mt-10 p-6">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-semibold text-gray-900">My Sets</h2>
          <ViewToggle view={view} setView={setView} />
        </div>

        {view === "grid" ? renderGridView() : renderTableView()}

        {photosets.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500">No photosets yet. Create one to get started!</p>
          </div>
        )}

        {isCreateModalOpen && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[20000]">
            <div className="bg-white rounded-lg p-6 w-96">
              <h3 className="font-medium mb-4">Name Your Photoset</h3>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreatePhotoset();
                }}
              >
                <input
                  type="text"
                  value={newSetName}
                  onChange={(e) => setNewSetName(e.target.value)}
                  placeholder="Photoset name..."
                  className="w-full px-4 py-2 rounded-lg border mb-4"
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsCreateModalOpen(false)}
                    className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600"
                    disabled={!newSetName.trim()}
                  >
                    Create
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
