import {
  h,
  derive,
  handler,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  str,
  UI,
} from "commontools";

// Plant growth stages
const PlantStage = {
  SEED: "seed",
  SEEDLING: "seedling", 
  PLANT: "plant"
} as const;

type PlantStage = typeof PlantStage[keyof typeof PlantStage];

// Emoji mappings for each stage
const PLANT_EMOJIS = {
  tomato: { seed: "🌰", seedling: "🌱", plant: "🍅" },
  flower: { seed: "🌰", seedling: "🌿", plant: "🌸" },
  tree: { seed: "🌰", seedling: "🌿", plant: "🌳" },
  sunflower: { seed: "🌰", seedling: "🌱", plant: "🌻" },
  rose: { seed: "🌰", seedling: "🌿", plant: "🌹" },
  cactus: { seed: "🌰", seedling: "🌵", plant: "🌵" },
  mushroom: { seed: "🟤", seedling: "🍄‍🟫", plant: "🍄" },
} as const;

type PlantType = keyof typeof PLANT_EMOJIS;

const PlantSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string", enum: Object.keys(PLANT_EMOJIS) },
    stage: { type: "string", enum: Object.values(PlantStage) },
    x: { type: "number" },
    y: { type: "number" },
    plantedAt: { type: "number" }, // timestamp
    wateredAt: { type: "number", default: 0 }, // timestamp of last watering
    plantedBy: { type: "string" },
    wateredBy: { type: "string", default: "" },
    harvestable: { type: "boolean", default: false },
  },
  required: ["id", "type", "stage", "x", "y", "plantedAt", "plantedBy"],
} as const satisfies JSONSchema;

type Plant = Schema<typeof PlantSchema>;

const EmojiGardenSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "🌱 Cozy Emoji Garden",
    },
    plants: {
      type: "array",
      items: PlantSchema,
      default: [],
    },
    selectedPlantType: {
      type: "string",
      enum: Object.keys(PLANT_EMOJIS),
      default: "flower",
    },
    lastUpdate: {
      type: "number",
      default: 0,
    },
    gardenHistory: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string" },
          player: { type: "string" },
          plantType: { type: "string" },
          timestamp: { type: "number" },
        },
        required: ["action", "player", "timestamp"],
      },
      default: [],
    },
  },
  required: ["title", "plants", "selectedPlantType", "lastUpdate", "gardenHistory"],
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    plants: { type: "array", items: PlantSchema },
    selectedPlantType: { type: "string" },
    lastUpdate: { type: "number" },
    gardenHistory: { type: "array", items: { type: "object" } },
    currentTime: { type: "number" },
    stats: {
      type: "object",
      properties: {
        totalPlants: { type: "number" },
        seedsCount: { type: "number" },
        seedlingsCount: { type: "number" },
        maturePlantsCount: { type: "number" },
      },
      required: ["totalPlants", "seedsCount", "seedlingsCount", "maturePlantsCount"],
    },
  },
  required: ["title", "plants", "selectedPlantType", "lastUpdate", "gardenHistory", "currentTime", "stats"],
} as const satisfies JSONSchema;

// Helper function to get hours since planting
const getHoursSincePlanting = (plantedAt: number, currentTime: number) => {
  return Math.floor((currentTime - plantedAt) / (1000 * 60 * 60));
};

// Helper function to determine plant stage based on time
const getPlantStage = (plantedAt: number, wateredAt: number, currentTime: number): PlantStage => {
  const hoursSincePlanting = getHoursSincePlanting(plantedAt, currentTime);
  const wasWatered = wateredAt > plantedAt;
  
  // Watering speeds up growth by 1 hour
  const effectiveHours = wasWatered ? hoursSincePlanting + 1 : hoursSincePlanting;
  
  if (effectiveHours >= 2) return PlantStage.PLANT;
  if (effectiveHours >= 1) return PlantStage.SEEDLING;
  return PlantStage.SEED;
};

// Generate unique plant ID
const generatePlantId = () => `plant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

// Plant a seed
const plantSeed = handler<
  { detail: { x: number; y: number; player: string } },
  { plants: Plant[]; selectedPlantType: string; gardenHistory: any[] }
>(({ detail }, { plants, selectedPlantType, gardenHistory }) => {
  if (!detail?.x || !detail?.y || !detail?.player) return;
  
  // Check if there's already a plant at this position (within 1 grid unit)
  const existingPlant = plants.find(plant => 
    Math.abs(plant.x - detail.x) < 1 && Math.abs(plant.y - detail.y) < 1
  );
  
  if (existingPlant) return; // Can't plant where there's already a plant
  
  const now = Date.now();
  const newPlant: Plant = {
    id: generatePlantId(),
    type: selectedPlantType as PlantType,
    stage: PlantStage.SEED,
    x: detail.x,
    y: detail.y,
    plantedAt: now,
    wateredAt: 0,
    plantedBy: detail.player,
    wateredBy: "",
    harvestable: false,
  };
  
  plants.push(newPlant);
  gardenHistory.push({
    action: "planted",
    player: detail.player,
    plantType: selectedPlantType,
    timestamp: now,
  });
});

// Water a plant
const waterPlant = handler<
  { detail: { plantId: string; player: string } },
  { plants: Plant[]; gardenHistory: any[] }
>(({ detail }, { plants, gardenHistory }) => {
  if (!detail?.plantId || !detail?.player) return;
  
  const plant = plants.find(p => p.id === detail.plantId);
  if (!plant) return;
  
  const now = Date.now();
  plant.wateredAt = now;
  plant.wateredBy = detail.player;
  
  gardenHistory.push({
    action: "watered",
    player: detail.player,
    plantType: plant.type,
    timestamp: now,
  });
});

// Harvest a plant
const harvestPlant = handler<
  { detail: { plantId: string; player: string } },
  { plants: Plant[]; gardenHistory: any[] }
>(({ detail }, { plants, gardenHistory }) => {
  if (!detail?.plantId || !detail?.player) return;
  
  const plantIndex = plants.findIndex(p => p.id === detail.plantId);
  if (plantIndex === -1) return;
  
  const plant = plants[plantIndex];
  if (plant.stage !== PlantStage.PLANT) return; // Can only harvest mature plants
  
  plants.splice(plantIndex, 1); // Remove the plant
  
  gardenHistory.push({
    action: "harvested",
    player: detail.player,
    plantType: plant.type,
    timestamp: Date.now(),
  });
});

// Change selected plant type
const selectPlantType = handler<
  { detail: { type: string } },
  { selectedPlantType: string }
>(({ detail }, state) => {
  if (detail?.type && Object.keys(PLANT_EMOJIS).includes(detail.type)) {
    state.selectedPlantType = detail.type;
  }
});

export default recipe(
  EmojiGardenSchema,
  ResultSchema,
  ({ title, plants, selectedPlantType, lastUpdate, gardenHistory }) => {
    const currentTime = derive(lastUpdate, () => Date.now());
    
    // Update plant stages based on current time
    const updatedPlants = derive([plants, currentTime], ([plantsArray, now]) => {
      return plantsArray.map(plant => ({
        ...plant,
        stage: getPlantStage(plant.plantedAt, plant.wateredAt, now),
        harvestable: getPlantStage(plant.plantedAt, plant.wateredAt, now) === PlantStage.PLANT,
      }));
    });
    
    // Calculate garden stats
    const stats = derive(updatedPlants, (plantsArray) => {
      const total = plantsArray.length;
      const seeds = plantsArray.filter(p => p.stage === PlantStage.SEED).length;
      const seedlings = plantsArray.filter(p => p.stage === PlantStage.SEEDLING).length;
      const mature = plantsArray.filter(p => p.stage === PlantStage.PLANT).length;
      
      return {
        totalPlants: total,
        seedsCount: seeds,
        seedlingsCount: seedlings,
        maturePlantsCount: mature,
      };
    });

    // Recent activity (last 10 actions)
    const recentActivity = derive(gardenHistory, (history) => {
      return history
        .slice(-10)
        .reverse()
        .map(entry => {
          const timeAgo = Math.floor((Date.now() - entry.timestamp) / (1000 * 60));
          return {
            ...entry,
            timeAgo: timeAgo < 1 ? "just now" : timeAgo === 1 ? "1 minute ago" : `${timeAgo} minutes ago`
          };
        });
    });

    return {
      [NAME]: title,
      [UI]: (
        <div style={{ padding: "1rem", maxWidth: "100%", overflow: "hidden" }}>
          <ct-card>
            <common-vstack gap="lg">
              {/* Header */}
              <div style={{ textAlign: "center" }}>
                <h2 style={{ margin: 0, fontSize: "2rem" }}>{title}</h2>
                <p style={{ margin: "0.5rem 0", color: "#666" }}>
                  Plant seeds, water them, and watch them grow! 🌱✨
                </p>
              </div>

              {/* Stats */}
              <ct-card>
                <common-hstack gap="md" style={{ justifyContent: "space-around", textAlign: "center" }}>
                  <div>
                    <div style={{ fontSize: "1.5rem" }}>🌰</div>
                    <div>{derive(stats, s => s.seedsCount)} seeds</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "1.5rem" }}>🌱</div>
                    <div>{derive(stats, s => s.seedlingsCount)} seedlings</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "1.5rem" }}>🌸</div>
                    <div>{derive(stats, s => s.maturePlantsCount)} mature</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "1.5rem" }}>🌾</div>
                    <div>{derive(stats, s => s.totalPlants)} total</div>
                  </div>
                </common-hstack>
              </ct-card>

              {/* Plant Selection */}
              <ct-card>
                <common-vstack gap="sm">
                  <h3 style={{ margin: 0 }}>🌱 Choose your seed:</h3>
                  <common-hstack gap="sm" style={{ flexWrap: "wrap" }}>
                    {Object.keys(PLANT_EMOJIS).map(plantType => (
                      <button
                        key={plantType}
                        style={{
                          padding: "0.5rem",
                          border: selectedPlantType === plantType ? "2px solid #4CAF50" : "1px solid #ddd",
                          borderRadius: "0.5rem",
                          background: selectedPlantType === plantType ? "#E8F5E9" : "white",
                          cursor: "pointer",
                          fontSize: "1.2rem",
                        }}
                        onclick={() => selectPlantType({ selectedPlantType })({ detail: { type: plantType } })}
                      >
                        {PLANT_EMOJIS[plantType as PlantType].plant} {plantType}
                      </button>
                    ))}
                  </common-hstack>
                  <p style={{ margin: 0, fontSize: "0.9rem", color: "#666" }}>
                    Selected: {PLANT_EMOJIS[selectedPlantType as PlantType].plant} {selectedPlantType}
                  </p>
                </common-vstack>
              </ct-card>

              {/* Garden Grid */}
              <ct-card>
                <common-vstack gap="sm">
                  <h3 style={{ margin: 0 }}>🏡 Your Garden (click empty spots to plant)</h3>
                  <div 
                    style={{ 
                      display: "grid", 
                      gridTemplateColumns: "repeat(8, 1fr)", 
                      gap: "4px",
                      maxWidth: "400px",
                      margin: "0 auto",
                      background: "#f0f8f0",
                      padding: "1rem",
                      borderRadius: "0.5rem",
                      border: "2px solid #e0e8e0"
                    }}
                  >
                    {Array.from({ length: 64 }, (_, index) => {
                      const x = index % 8;
                      const y = Math.floor(index / 8);
                      const plant = derive(updatedPlants, (plantsArray) => 
                        plantsArray.find(p => Math.floor(p.x) === x && Math.floor(p.y) === y)
                      );
                      
                      return (
                        <div
                          key={`${x}-${y}`}
                          style={{
                            width: "40px",
                            height: "40px",
                            border: "1px solid #ddd",
                            borderRadius: "4px",
                            background: "#fafcfa",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "pointer",
                            fontSize: "1.5rem",
                            position: "relative",
                          }}
                          onclick={() => {
                            const currentPlant = plant;
                            const playerName = prompt("What's your gardener name?") || "Anonymous";
                            
                            if (!currentPlant) {
                              // Plant new seed
                              plantSeed({ plants, selectedPlantType, gardenHistory })({ 
                                detail: { x, y, player: playerName } 
                              });
                            } else if (currentPlant.stage !== PlantStage.PLANT) {
                              // Water existing plant
                              waterPlant({ plants, gardenHistory })({ 
                                detail: { plantId: currentPlant.id, player: playerName } 
                              });
                            } else {
                              // Harvest mature plant
                              if (confirm(`Harvest this ${currentPlant.type}?`)) {
                                harvestPlant({ plants, gardenHistory })({ 
                                  detail: { plantId: currentPlant.id, player: playerName } 
                                });
                              }
                            }
                          }}
                        >
                          {derive(plant, (p) => {
                            if (!p) return "⬜"; // Empty spot
                            const emoji = PLANT_EMOJIS[p.type as PlantType][p.stage as keyof typeof PLANT_EMOJIS[PlantType]];
                            return emoji;
                          })}
                          
                          {/* Show plant info on hover */}
                          {derive(plant, (p) => p ? (
                            <div style={{
                              position: "absolute",
                              bottom: "100%",
                              left: "50%",
                              transform: "translateX(-50%)",
                              background: "rgba(0,0,0,0.8)",
                              color: "white",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              whiteSpace: "nowrap",
                              opacity: 0,
                              pointerEvents: "none",
                              transition: "opacity 0.2s",
                            }}>
                              {p.type} by {p.plantedBy}
                              {p.wateredBy && ` (💧 ${p.wateredBy})`}
                            </div>
                          ) : null)}
                        </div>
                      );
                    })}
                  </div>
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "#666", textAlign: "center" }}>
                    💡 Click empty spots to plant • Click plants to water • Click mature plants to harvest
                  </p>
                </common-vstack>
              </ct-card>

              {/* Recent Activity */}
              <ct-card>
                <common-vstack gap="sm">
                  <h3 style={{ margin: 0 }}>📜 Recent Garden Activity</h3>
                  <div style={{ maxHeight: "200px", overflow: "auto" }}>
                    {derive(recentActivity, (activities) => 
                      activities.length === 0 ? (
                        <p style={{ color: "#666", fontStyle: "italic" }}>
                          No activity yet. Be the first to plant something! 🌱
                        </p>
                      ) : (
                        activities.map((activity, index) => (
                          <div key={index} style={{ 
                            padding: "0.5rem", 
                            borderBottom: "1px solid #eee",
                            fontSize: "0.9rem"
                          }}>
                            <strong>{activity.player}</strong> {activity.action} {
                              activity.plantType && `a ${activity.plantType}`
                            } <span style={{ color: "#666" }}>({activity.timeAgo})</span>
                          </div>
                        ))
                      )
                    )}
                  </div>
                </common-vstack>
              </ct-card>

              {/* Growth Guide */}
              <ct-card>
                <common-vstack gap="sm">
                  <h3 style={{ margin: 0 }}>🌱 Growth Guide</h3>
                  <div style={{ fontSize: "0.9rem", color: "#666" }}>
                    <p>🌰 <strong>Seeds</strong> take 1 hour to become seedlings</p>
                    <p>🌱 <strong>Seedlings</strong> take another hour to become mature plants</p>
                    <p>💧 <strong>Watering</strong> speeds up growth by 1 hour!</p>
                    <p>🌸 <strong>Mature plants</strong> can be harvested to make room for new seeds</p>
                    <p>🤝 <strong>Multiplayer:</strong> Anyone can tend to any plant in the garden</p>
                  </div>
                </common-vstack>
              </ct-card>
            </common-vstack>
          </ct-card>
        </div>
      ),
      title,
      plants: updatedPlants,
      selectedPlantType,
      lastUpdate,
      gardenHistory,
      currentTime,
      stats,
    };
  }
);