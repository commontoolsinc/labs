import { CTAudioVisualizer } from "./ct-audio-visualizer.ts";

if (!customElements.get("ct-audio-visualizer")) {
  customElements.define("ct-audio-visualizer", CTAudioVisualizer);
}

export { CTAudioVisualizer };
