import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getPhotoSets, savePhotoSet, deletePhotoSet } from "@/utils/photoset";

export default function PhotoFlowIndex() {
  const navigate = useNavigate();
  const photosets = getPhotoSets();
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

  return (
    <div className="max-w-7xl mx-auto mt-10 p-6">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold text-gray-900">PhotoFlow</h1>
        <button
          onClick={() => setIsCreateModalOpen(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
        >
          Create PhotoSet
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {photosets.map((photoset) => (
          <div
            key={photoset.id}
            onClick={() => navigate(`/experiments/photoflow/${photoset.name}`)}
            className="border rounded-lg p-6 cursor-pointer hover:border-blue-500 transition-colors relative group"
          >
            <button
              onClick={(e) => handleDeletePhotoset(e, photoset.id)}
              className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-6 h-6 flex items-center justify-center hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              ×
            </button>
            <h2 className="text-xl font-semibold text-gray-900">{photoset.name}</h2>
            <p className="text-gray-500 mt-1">
              Created on {new Date(photoset.createdAt).toLocaleDateString()}
            </p>
            <p className="text-gray-500 mt-2">
              {photoset.images.length} image{photoset.images.length !== 1 ? "s" : ""}
            </p>
          </div>
        ))}
      </div>

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
  );
}
