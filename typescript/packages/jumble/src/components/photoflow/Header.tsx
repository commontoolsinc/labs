import { useNavigate, useLocation } from "react-router-dom";
import { LuWandSparkles } from "react-icons/lu";

interface HeaderProps {
  setIsCreateModalOpen?: (open: boolean) => void;
  onOpenScratchpad?: () => void;
}

export default function Header({ setIsCreateModalOpen, onOpenScratchpad }: HeaderProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isIndex = location.pathname === "/experiments/photoflow";
  const isPhotoSetView = location.pathname.startsWith("/experiments/photoflow/") && !isIndex;

  return (
    <header className="bg-white border-b">
      <div className="max-w-7xl mx-auto px-6 py-4">
        <div className="flex justify-between items-center">
          <button
            onClick={() => navigate("/experiments/photoflow")}
            className="text-lg font-medium text-gray-900 hover:text-blue-600 transition-colors"
          >
            PhotoFlow
          </button>
          <div className="flex items-center gap-4">
            {isIndex && setIsCreateModalOpen && (
              <button
                onClick={() => setIsCreateModalOpen(true)}
                className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                Create Set
              </button>
            )}
            {isPhotoSetView && onOpenScratchpad && (
              <button onClick={onOpenScratchpad} className="text-black hover:text-gray-700">
                <LuWandSparkles size={24} />
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
