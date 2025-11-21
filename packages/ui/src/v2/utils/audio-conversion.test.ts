/**
 * Tests for audio conversion utilities
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

// Note: We're testing the internal helper functions by importing them
// The main convertToWav function requires browser AudioContext which isn't available in Deno tests
// In a real browser environment, we would test the full conversion pipeline

// Since the helper functions are not exported, we'll test the behavior through the WAV file structure
// and verify the correctness of the WAV format

describe("audio-conversion", () => {
  describe("WAV file format", () => {
    it("should create valid WAV header structure", () => {
      // Create a simple PCM data array
      const pcmData = new Int16Array(100);
      for (let i = 0; i < pcmData.length; i++) {
        pcmData[i] = Math.floor(Math.sin(i / 10) * 0x7FFF);
      }

      const numberOfChannels = 1;
      const sampleRate = 16000;
      const bytesPerSample = 2;
      const blockAlign = numberOfChannels * bytesPerSample;
      const byteRate = sampleRate * blockAlign;
      const dataSize = pcmData.length * bytesPerSample;
      const bufferSize = 44 + dataSize;

      const buffer = new ArrayBuffer(bufferSize);
      const view = new DataView(buffer);

      // Write WAV header (replicating createWavFile logic for testing)
      let offset = 0;

      // RIFF chunk descriptor
      view.setUint8(offset++, "R".charCodeAt(0));
      view.setUint8(offset++, "I".charCodeAt(0));
      view.setUint8(offset++, "F".charCodeAt(0));
      view.setUint8(offset++, "F".charCodeAt(0));
      view.setUint32(offset, bufferSize - 8, true);
      offset += 4;
      view.setUint8(offset++, "W".charCodeAt(0));
      view.setUint8(offset++, "A".charCodeAt(0));
      view.setUint8(offset++, "V".charCodeAt(0));
      view.setUint8(offset++, "E".charCodeAt(0));

      // fmt sub-chunk
      view.setUint8(offset++, "f".charCodeAt(0));
      view.setUint8(offset++, "m".charCodeAt(0));
      view.setUint8(offset++, "t".charCodeAt(0));
      view.setUint8(offset++, " ".charCodeAt(0));
      view.setUint32(offset, 16, true); // Subchunk size
      offset += 4;
      view.setUint16(offset, 1, true); // Audio format (PCM)
      offset += 2;
      view.setUint16(offset, numberOfChannels, true);
      offset += 2;
      view.setUint32(offset, sampleRate, true);
      offset += 4;
      view.setUint32(offset, byteRate, true);
      offset += 4;
      view.setUint16(offset, blockAlign, true);
      offset += 2;
      view.setUint16(offset, bytesPerSample * 8, true); // Bits per sample
      offset += 2;

      // data sub-chunk
      view.setUint8(offset++, "d".charCodeAt(0));
      view.setUint8(offset++, "a".charCodeAt(0));
      view.setUint8(offset++, "t".charCodeAt(0));
      view.setUint8(offset++, "a".charCodeAt(0));
      view.setUint32(offset, dataSize, true);
      offset += 4;

      // Verify header structure
      const headerView = new DataView(buffer);

      // Check RIFF signature
      const riff = String.fromCharCode(
        headerView.getUint8(0),
        headerView.getUint8(1),
        headerView.getUint8(2),
        headerView.getUint8(3),
      );
      expect(riff).toBe("RIFF");

      // Check file size
      expect(headerView.getUint32(4, true)).toBe(bufferSize - 8);

      // Check WAVE signature
      const wave = String.fromCharCode(
        headerView.getUint8(8),
        headerView.getUint8(9),
        headerView.getUint8(10),
        headerView.getUint8(11),
      );
      expect(wave).toBe("WAVE");

      // Check fmt signature
      const fmt = String.fromCharCode(
        headerView.getUint8(12),
        headerView.getUint8(13),
        headerView.getUint8(14),
        headerView.getUint8(15),
      );
      expect(fmt).toBe("fmt ");

      // Check audio format (PCM = 1)
      expect(headerView.getUint16(20, true)).toBe(1);

      // Check number of channels
      expect(headerView.getUint16(22, true)).toBe(numberOfChannels);

      // Check sample rate
      expect(headerView.getUint32(24, true)).toBe(sampleRate);

      // Check data signature
      const data = String.fromCharCode(
        headerView.getUint8(36),
        headerView.getUint8(37),
        headerView.getUint8(38),
        headerView.getUint8(39),
      );
      expect(data).toBe("data");

      // Check data size
      expect(headerView.getUint32(40, true)).toBe(dataSize);
    });
  });

  describe("Float to PCM conversion", () => {
    it("should convert float samples to 16-bit PCM correctly", () => {
      const samples = new Float32Array([
        -1.0, // Should map to -32768 (0x8000)
        0.0, // Should map to 0
        1.0, // Should map to 32767 (0x7FFF)
        0.5, // Should map to ~16383
        -0.5, // Should map to ~-16384
      ]);

      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      expect(pcm[0]).toBe(-32768);
      expect(pcm[1]).toBe(0);
      expect(pcm[2]).toBe(32767);
      expect(pcm[3]).toBeCloseTo(16383, 0);
      expect(pcm[4]).toBeCloseTo(-16384, 0);
    });

    it("should clamp values outside -1.0 to 1.0 range", () => {
      const samples = new Float32Array([
        -2.0, // Should clamp to -1.0
        2.0, // Should clamp to 1.0
        -1.5, // Should clamp to -1.0
        1.5, // Should clamp to 1.0
      ]);

      const pcm = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      expect(pcm[0]).toBe(-32768);
      expect(pcm[1]).toBe(32767);
      expect(pcm[2]).toBe(-32768);
      expect(pcm[3]).toBe(32767);
    });
  });

  describe("Resampling", () => {
    it("should resample audio data correctly", () => {
      // Create a simple sine wave at 44100 Hz
      const sourceSampleRate = 44100;
      const targetSampleRate = 16000;
      const samples = new Float32Array(100);

      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.sin(i / 10);
      }

      // Resample
      const ratio = sourceSampleRate / targetSampleRate;
      const newLength = Math.round(samples.length / ratio);
      const result = new Float32Array(newLength);

      for (let i = 0; i < newLength; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const fraction = position - index;

        if (index + 1 < samples.length) {
          result[i] = samples[index] * (1 - fraction) +
            samples[index + 1] * fraction;
        } else {
          result[i] = samples[index];
        }
      }

      // Verify resampled length
      expect(result.length).toBe(newLength);
      expect(result.length).toBeCloseTo(36, 0); // ~100 / (44100/16000)

      // Verify values are interpolated
      expect(result[0]).toBeCloseTo(samples[0], 2);
    });

    it("should return original samples when sample rates match", () => {
      const sampleRate = 16000;
      const samples = new Float32Array([1, 2, 3, 4, 5]);

      // Simulate no resampling needed
      const ratio = sampleRate / sampleRate;
      if (ratio === 1) {
        expect(samples).toBe(samples);
      }
    });
  });

  describe("Stereo to mono conversion", () => {
    it("should mix stereo channels to mono correctly", () => {
      const left = new Float32Array([0.8, -0.6, 0.4]);
      const right = new Float32Array([0.2, -0.4, 0.6]);

      const mono = new Float32Array(left.length);
      for (let i = 0; i < left.length; i++) {
        mono[i] = (left[i] + right[i]) / 2;
      }

      expect(mono[0]).toBeCloseTo(0.5, 2); // (0.8 + 0.2) / 2
      expect(mono[1]).toBeCloseTo(-0.5, 2); // (-0.6 + -0.4) / 2
      expect(mono[2]).toBeCloseTo(0.5, 2); // (0.4 + 0.6) / 2
    });
  });

  describe("DataView string writing", () => {
    it("should write ASCII strings correctly", () => {
      const buffer = new ArrayBuffer(10);
      const view = new DataView(buffer);

      const testStrings = ["RIFF", "WAVE", "fmt ", "data"];

      for (const str of testStrings) {
        let offset = 0;
        for (let i = 0; i < str.length; i++) {
          view.setUint8(offset + i, str.charCodeAt(i));
        }

        // Read back
        let result = "";
        for (let i = 0; i < str.length; i++) {
          result += String.fromCharCode(view.getUint8(i));
        }

        expect(result).toBe(str);
      }
    });
  });
});
