import { useRef, useEffect } from "react";

// Minimum time animation stays active after last update
const MIN_ANIMATION_DURATION = 800;

/**
 * Hook for smoothing animation values with easing 
 * and minimum duration for network operation indicators
 */
export function useAnimationSmoothing(
  initialValues: Record<string, number> = {}
) {
  // Animation refs
  const rafRef = useRef<number | null>(null);
  const easedValuesRef = useRef<Record<string, number>>({});
  const lastUpdatesRef = useRef<Record<string, number>>({});
  
  // Initialize refs with provided initial values
  useEffect(() => {
    Object.entries(initialValues).forEach(([key, value]) => {
      easedValuesRef.current[key] = value;
      lastUpdatesRef.current[key] = 0;
    });
  }, []);
  
  // Helper function for easing values
  const ease = (current: number, target: number, factor: number = 0.1) => {
    return current + (target - current) * factor;
  };
  
  /**
   * Update a value with easing effect
   * @param key Unique identifier for the value
   * @param actualValue The current actual value to ease toward
   * @param isActive Whether the animation is active (reset timestamp)
   * @param easingFactor Optional easing factor (0-1)
   */
  const updateValue = (
    key: string, 
    actualValue: number, 
    isActive: boolean = true,
    easingFactor: number = 0.06
  ) => {
    const now = Date.now();
    
    // Initialize if doesn't exist
    if (easedValuesRef.current[key] === undefined) {
      easedValuesRef.current[key] = 0;
      lastUpdatesRef.current[key] = 0;
    }
    
    // Update timestamp if value increased or is manually set as active
    if (isActive || actualValue > Math.round(easedValuesRef.current[key])) {
      lastUpdatesRef.current[key] = now;
    }
    
    // Determine if animation should be active (min duration logic)
    const isAnimationActive = actualValue > 0 || 
      (now - lastUpdatesRef.current[key] < MIN_ANIMATION_DURATION);
    
    // Update eased value
    easedValuesRef.current[key] = ease(
      easedValuesRef.current[key],
      isAnimationActive ? Math.max(actualValue, 0.01) : 0,
      easingFactor
    );
    
    // Return displayable rounded value
    return {
      value: Math.round(easedValuesRef.current[key]),
      isActive: isAnimationActive
    };
  };
  
  /**
   * Get the current eased value
   * @param key Unique identifier for the value
   */
  const getValue = (key: string) => {
    const now = Date.now();
    
    if (easedValuesRef.current[key] === undefined) {
      return { value: 0, isActive: false };
    }
    
    const isAnimationActive = 
      Math.round(easedValuesRef.current[key]) > 0 || 
      (now - lastUpdatesRef.current[key] < MIN_ANIMATION_DURATION);
    
    return {
      value: Math.round(easedValuesRef.current[key]),
      isActive: isAnimationActive
    };
  };
  
  // Cleanup animation frame on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);
  
  return {
    updateValue,
    getValue,
    rafRef
  };
}