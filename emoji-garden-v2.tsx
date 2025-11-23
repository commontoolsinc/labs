/// <cts-enable />
import {
  Cell,
  Default,
  derive,
  h,
  handler,
  NAME,
  recipe,
  UI,
} from "commontools";

interface Plant {
  id: string;
  type: string;
  stage: "seed" | "seedling" | "plant";
  x: number;
  y: number;
  plantedAt: number;
  plantedBy: string;
  wateredAt?: number;
  wateredBy?: string;
}

interface GardenInput {
  title: Default<string, "🌱 Cozy Emoji Garden">;
  plants: Default<Plant[], []>;
  selectedPlantType: Default<string, "flower">;
}

interface GardenOutput extends GardenInput {
  stats: {
    total: number;
    seeds: number;
    seedlings: number;
    mature: number;
  };
}

// Plant emoji mappings
const PLANT_EMOJIS: Record<string, { seed: string; seedling: string; plant: string }> = {
  flower: { seed: "🌰", seedling: "🌿", plant: "🌸" },
  tomato: { seed: "🌰", seedling: "🌱", plant: "🍅" },
  sunflower: { seed: "🌰", seedling: "🌱", plant: "🌻" },
  tree: { seed: "🌰", seedling: "🌿", plant: "🌳" },
  rose: { seed: "🌰", seedling: "🌿", plant: "🌹" },
  cactus: { seed: "🌰", seedling: "🌵", plant: "🌵" },
};

// Helper to get plant stage based on time
const getPlantStage = (plantedAt: number, wateredAt?: number): "seed" | "seedling" | "plant" => {
  const now = Date.now();
  const hoursSincePlanting = Math.floor((now - plantedAt) / (1000 * 60 * 60));
  const wasWatered = wateredAt && wateredAt > plantedAt;
  
  // Watering speeds up growth by 1 hour
  const effectiveHours = wasWatered ? hoursSincePlanting + 1 : hoursSincePlanting;
  
  if (effectiveHours >= 2) return "plant";
  if (effectiveHours >= 1) return "seedling";
  return "seed";
};

// Generate unique plant ID
const generateId = () => `plant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

const plantSeed = handler<
  unknown,
  { plants: Cell<Plant[]>; selectedPlantType: Cell<string>; x: number; y: number }
>((_, { plants, selectedPlantType, x, y }) => {
  const currentPlants = plants.get();
  const plantType = selectedPlantType.get();
  
  // Check if spot is occupied
  const occupied = currentPlants.some(p => 
    Math.abs(p.x - x) < 1 && Math.abs(p.y - y) < 1
  );
  
  if (occupied) return;
  
  const newPlant: Plant = {
    id: generateId(),
    type: plantType,
    stage: "seed",
    x: x,
    y: y,
    plantedAt: Date.now(),
    plantedBy: "Gardener", // Simple for now
  };
  
  plants.set([...currentPlants, newPlant]);
});

const waterPlant = handler<
  unknown,
  { plants: Cell<Plant[]>; plantId: string }
>((_, { plants, plantId }) => {
  const currentPlants = plants.get();
  const updatedPlants = currentPlants.map(plant => 
    plant.id === plantId 
      ? { ...plant, wateredAt: Date.now(), wateredBy: "Gardener" }
      : plant
  );
  plants.set(updatedPlants);
});

const harvestPlant = handler<
  unknown,
  { plants: Cell<Plant[]>; plantId: string }
>((_, { plants, plantId }) => {
  const currentPlants = plants.get();
  const updatedPlants = currentPlants.filter(plant => plant.id !== plantId);
  plants.set(updatedPlants);
});

const selectPlantType = handler<
  unknown,
  { selectedPlantType: Cell<string>; type: string }
>((_, { selectedPlantType, type }) => {
  selectedPlantType.set(type);
});

export default recipe<GardenInput, GardenOutput>(
  "Emoji Garden",
  ({ title, plants, selectedPlantType }) => {
    // Calculate current plant stages
    const currentPlants = derive(plants, (plantsArray) => {
      return plantsArray.map(plant => ({
        ...plant,
        stage: getPlantStage(plant.plantedAt, plant.wateredAt),
      }));
    });

    // Calculate stats
    const stats = derive(currentPlants, (plantsArray) => {
      return {
        total: plantsArray.length,
        seeds: plantsArray.filter(p => p.stage === "seed").length,
        seedlings: plantsArray.filter(p => p.stage === "seedling").length,
        mature: plantsArray.filter(p => p.stage === "plant").length,
      };
    });

    return {
      [NAME]: title,
      [UI]: (
        <div style="padding: 1rem; max-width: 800px;">
          <common-vstack gap="lg">
            {/* Header */}
            <div style="text-align: center;">
              <h2 style="margin: 0; font-size: 2rem;">{title}</h2>
              <p style="margin: 0.5rem 0; color: #666;">
                Plant seeds, water them, and watch them grow! 🌱✨
              </p>
            </div>

            {/* Stats */}
            <ct-card>
              <common-hstack gap="md" style="justify-content: space-around; text-align: center;">
                <div>
                  <div style="font-size: 1.5rem;">🌰</div>
                  <div>{derive(stats, s => s.seeds)} seeds</div>
                </div>
                <div>
                  <div style="font-size: 1.5rem;">🌱</div>
                  <div>{derive(stats, s => s.seedlings)} seedlings</div>
                </div>
                <div>
                  <div style="font-size: 1.5rem;">🌸</div>
                  <div>{derive(stats, s => s.mature)} mature</div>
                </div>
                <div>
                  <div style="font-size: 1.5rem;">🌾</div>
                  <div>{derive(stats, s => s.total)} total</div>
                </div>
              </common-hstack>
            </ct-card>

            {/* Plant Selection */}
            <ct-card>
              <common-vstack gap="sm">
                <h3 style="margin: 0;">🌱 Choose your seed:</h3>
                <common-hstack gap="sm" style="flex-wrap: wrap;">
                  {Object.keys(PLANT_EMOJIS).map(plantType => (
                    <ct-button
                      key={plantType}
                      variant={derive(selectedPlantType, selected => selected === plantType ? "primary" : "default")}
                      onClick={selectPlantType({ selectedPlantType, type: plantType })}
                    >
                      {PLANT_EMOJIS[plantType].plant} {plantType}
                    </ct-button>
                  ))}
                </common-hstack>
                <p style="margin: 0; font-size: 0.9rem; color: #666;">
                  Selected: {derive(selectedPlantType, selected => 
                    `${PLANT_EMOJIS[selected]?.plant || "🌸"} ${selected}`
                  )}
                </p>
              </common-vstack>
            </ct-card>

            {/* Garden Grid */}
            <ct-card>
              <common-vstack gap="sm">
                <h3 style="margin: 0;">🏡 Your Garden (click empty spots to plant)</h3>
                <div style="
                  display: grid; 
                  grid-template-columns: repeat(8, 1fr); 
                  gap: 4px;
                  max-width: 400px;
                  margin: 0 auto;
                  background: #f0f8f0;
                  padding: 1rem;
                  border-radius: 0.5rem;
                  border: 2px solid #e0e8e0;
                ">
                  {Array.from({ length: 64 }, (_, index) => {
                    const x = index % 8;
                    const y = Math.floor(index / 8);
                    
                    const plantAtSpot = derive(currentPlants, (plantsArray) => 
                      plantsArray.find(p => Math.floor(p.x) === x && Math.floor(p.y) === y)
                    );
                    
                    return (
                      <div
                        key={`${x}-${y}`}
                        style="
                          width: 40px;
                          height: 40px;
                          border: 1px solid #ddd;
                          border-radius: 4px;
                          background: #fafcfa;
                          display: flex;
                          align-items: center;
                          justify-content: center;
                          cursor: pointer;
                          font-size: 1.5rem;
                        "
                        onClick={() => {
                          const plant = derive(currentPlants, (plantsArray) => 
                            plantsArray.find(p => Math.floor(p.x) === x && Math.floor(p.y) === y)
                          );
                          
                          if (!plant) {
                            // Plant new seed
                            plantSeed({ plants, selectedPlantType, x, y })();
                          } else if (plant.stage !== "plant") {
                            // Water existing plant
                            waterPlant({ plants, plantId: plant.id })();
                          } else {
                            // Harvest mature plant
                            harvestPlant({ plants, plantId: plant.id })();
                          }
                        }}
                      >
                        {derive(plantAtSpot, (plant) => {
                          if (!plant) return "⬜";
                          const emojis = PLANT_EMOJIS[plant.type];
                          return emojis ? emojis[plant.stage] : "🌱";
                        })}
                      </div>
                    );
                  })}
                </div>
                <p style="margin: 0; font-size: 0.8rem; color: #666; text-align: center;">
                  💡 Click empty spots to plant • Click plants to water • Click mature plants to harvest
                </p>
              </common-vstack>
            </ct-card>

            {/* Growth Guide */}
            <ct-card>
              <common-vstack gap="sm">
                <h3 style="margin: 0;">🌱 Growth Guide</h3>
                <div style="font-size: 0.9rem; color: #666;">
                  <p>🌰 <strong>Seeds</strong> take 1 hour to become seedlings</p>
                  <p>🌱 <strong>Seedlings</strong> take another hour to become mature plants</p>
                  <p>💧 <strong>Watering</strong> speeds up growth by 1 hour!</p>
                  <p>🌸 <strong>Mature plants</strong> can be harvested to make room for new seeds</p>
                  <p>🤝 <strong>Multiplayer:</strong> Everyone shares the same garden space</p>
                </div>
              </common-vstack>
            </ct-card>
          </common-vstack>
        </div>
      ),
      title,
      plants,
      selectedPlantType,
      stats,
    };
  }
);