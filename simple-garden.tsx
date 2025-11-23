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
  emoji: string;
  x: number;
  y: number;
  plantedAt: number;
}

interface GardenInput {
  title: Default<string, "🌱 Emoji Garden">;
  plants: Default<Plant[], []>;
  selectedEmoji: Default<string, "🌸">;
}

interface GardenOutput extends GardenInput {}

// Available plant emojis
const PLANT_OPTIONS = ["🌸", "🌻", "🌹", "🌷", "🌺", "🌼", "🌵", "🌿", "🍄"];

const generateId = () => `plant_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

const addPlant = handler<
  { detail: { x: number; y: number } },
  { plants: Cell<Plant[]>; selectedEmoji: Cell<string> }
>(({ detail }, { plants, selectedEmoji }) => {
  const currentPlants = plants.get();
  const emoji = selectedEmoji.get();
  
  // Check if spot is occupied
  const occupied = currentPlants.some(p => p.x === detail.x && p.y === detail.y);
  if (occupied) return;
  
  const newPlant: Plant = {
    id: generateId(),
    emoji: emoji,
    x: detail.x,
    y: detail.y,
    plantedAt: Date.now(),
  };
  
  plants.set([...currentPlants, newPlant]);
});

const removePlant = handler<
  { detail: { x: number; y: number } },
  { plants: Cell<Plant[]> }
>(({ detail }, { plants }) => {
  const currentPlants = plants.get();
  const updatedPlants = currentPlants.filter(p => !(p.x === detail.x && p.y === detail.y));
  plants.set(updatedPlants);
});

const selectEmoji = handler<
  { detail: { emoji: string } },
  { selectedEmoji: Cell<string> }
>(({ detail }, { selectedEmoji }) => {
  selectedEmoji.set(detail.emoji);
});

export default recipe<GardenInput, GardenOutput>(
  "Simple Garden",
  ({ title, plants, selectedEmoji }) => {
    return {
      [NAME]: title,
      [UI]: (
        <div style="padding: 1rem; max-width: 600px;">
          <common-vstack gap="lg">
            {/* Header */}
            <div style="text-align: center;">
              <h2 style="margin: 0;">{title}</h2>
              <p style="margin: 0.5rem 0; color: #666;">
                Click empty spots to plant! 🌱
              </p>
            </div>

            {/* Stats */}
            <ct-card>
              <div style="text-align: center;">
                <strong>{derive(plants, p => p.length)} plants in your garden</strong>
              </div>
            </ct-card>

            {/* Plant Selection */}
            <ct-card>
              <common-vstack gap="sm">
                <h3 style="margin: 0;">Choose your plant:</h3>
                <common-hstack gap="sm" style="flex-wrap: wrap;">
                  {PLANT_OPTIONS.map(emoji => (
                    <ct-button
                      key={emoji}
                      variant={derive(selectedEmoji, selected => selected === emoji ? "primary" : "default")}
                      onClick={() => selectEmoji({ selectedEmoji })({ detail: { emoji } })}
                    >
                      {emoji}
                    </ct-button>
                  ))}
                </common-hstack>
                <p style="margin: 0; color: #666;">
                  Selected: {selectedEmoji}
                </p>
              </common-vstack>
            </ct-card>

            {/* Garden Grid */}
            <ct-card>
              <common-vstack gap="sm">
                <h3 style="margin: 0;">🏡 Your Garden</h3>
                <div style="
                  display: grid; 
                  grid-template-columns: repeat(6, 1fr); 
                  gap: 4px;
                  background: #f0f8f0;
                  padding: 1rem;
                  border-radius: 0.5rem;
                  border: 2px solid #e0e8e0;
                ">
                  {Array.from({ length: 36 }, (_, index) => {
                    const x = index % 6;
                    const y = Math.floor(index / 6);
                    
                    const plantAtSpot = derive(plants, (plantsArray) => 
                      plantsArray.find(p => p.x === x && p.y === y)
                    );
                    
                    return (
                      <div
                        key={`${x}-${y}`}
                        style="
                          width: 50px;
                          height: 50px;
                          border: 1px solid #ddd;
                          border-radius: 4px;
                          background: #fafcfa;
                          display: flex;
                          align-items: center;
                          justify-content: center;
                          cursor: pointer;
                          font-size: 1.8rem;
                        "
                        onClick={() => {
                          const plant = derive(plants, (plantsArray) => 
                            plantsArray.find(p => p.x === x && p.y === y)
                          );
                          
                          if (!plant) {
                            addPlant({ plants, selectedEmoji })({ detail: { x, y } });
                          } else {
                            removePlant({ plants })({ detail: { x, y } });
                          }
                        }}
                      >
                        {derive(plantAtSpot, (plant) => plant ? plant.emoji : "⬜")}
                      </div>
                    );
                  })}
                </div>
                <p style="margin: 0; font-size: 0.8rem; color: #666; text-align: center;">
                  💡 Click empty spots to plant • Click plants to remove
                </p>
              </common-vstack>
            </ct-card>
          </common-vstack>
        </div>
      ),
      title,
      plants,
      selectedEmoji,
    };
  }
);