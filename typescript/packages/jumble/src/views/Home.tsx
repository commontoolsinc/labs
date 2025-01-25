import { useState } from "react";
import BlobCanvas from "@/components/BlobCanvas.tsx";
import { useAllBlobs } from "@/utils/api.ts";
import { useNavigate } from "react-router-dom";
import { savePhotoSet } from "@/utils/photoset";

export default function Home() {
  const { blobs } = useAllBlobs();
  const navigate = useNavigate();
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
    navigate(`/data/${photoset.name}`);
  };

  return (
    <div className="h-full relative">
      <BlobCanvas blobs={blobs} />

      <button
        onClick={() => setIsCreateModalOpen(true)}
        className="fixed bottom-8 right-8 px-6 py-3 bg-blue-500 text-white rounded-full shadow-lg hover:bg-blue-600 transition-colors"
      >
        Create Photoset
      </button>

      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[20000]">
          <div className="bg-white rounded-lg p-6 w-96">
            <h3 className="font-medium mb-4">Name Your Photoset</h3>
            <input
              type="text"
              value={newSetName}
              onChange={e => setNewSetName(e.target.value)}
              placeholder="Photoset name..."
              className="w-full px-4 py-2 rounded-lg border mb-4"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setIsCreateModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200"
              >
                Cancel
              </button>
              <button
                onClick={handleCreatePhotoset}
                className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600"
                disabled={!newSetName.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
