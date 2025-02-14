import { Charm } from "@commontools/charm";
import { CharmRenderer } from "@/components/CharmRunner";
import { charmId } from "@/utils/charms";
import { useNavigate, useParams } from "react-router-dom";

interface VariantTrayProps {
  variants: Charm[];
  selectedVariant: Charm | null;
  onSelectVariant: (charm: Charm) => void;
  variantModels: string[];
}

export function VariantTray({
  variants,
  selectedVariant,
  onSelectVariant,
  variantModels,
}: VariantTrayProps) {
  const navigate = useNavigate();
  const { replicaName } = useParams();

  return (
    <div className="absolute inset-x-4 bottom-24 bg-white/95 backdrop-blur border-2 border-black p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold">Choose a variant</h3>
        <button
          onClick={() => selectedVariant && navigate(`/${replicaName}/${charmId(selectedVariant)}`)}
          className="px-4 py-2 bg-black text-white rounded hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          disabled={!selectedVariant}
        >
          Choose
        </button>
      </div>
      <div className="flex gap-4 overflow-x-auto ">
        {variants.map((variant, i) => (
          <div key={i} className="flex flex-col items-center">
            <button
              onClick={() => onSelectVariant(variant)}
              className={`
                flex-shrink-0 w-80 h-56 border-2 border-black overflow-hidden relative
                ${variant === selectedVariant ? "opacity-100 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.7)] -translate-y-0.5" : "opacity-30 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.5)]"}
                transition-all duration-150 ease-in-out transform-gpu mt-0.5
              `}
            >
              <div
                style={{
                  width: "1024px",
                  height: "768px",
                  transform: "scale(0.31)",
                  transformOrigin: "top left",
                }}
              >
                <CharmRenderer charm={variant} className="w-full h-full" />
              </div>
              {/* Transparent overlay to prevent iframe interaction */}
              <div className="absolute inset-0" />
            </button>
            <div className="mt-2 text-xs text-gray-600 text-center">
              <div className="text-[10px] font-bold">{variantModels[i]}</div>
              <div className="text-[8px]">{charmId(variant)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
