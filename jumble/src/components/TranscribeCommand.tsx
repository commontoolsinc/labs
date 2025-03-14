import { useEffect } from "react";
import { useAudioRecorder } from "@/hooks/use-audio-recorder.ts";
import {
  CommandContext,
  CommandItem,
  TranscribeCommandItem,
} from "./commands.ts";
import { DitheredCube } from "./DitherCube.tsx";

interface TranscribeInputProps {
  mode: { command: CommandItem; placeholder: string };
  context: CommandContext;
}

export function TranscribeInput({ mode, context }: TranscribeInputProps) {
  const {
    isRecording,
    isTranscribing,
    recordingSeconds,
    startRecording,
    stopRecording,
  } = useAudioRecorder({
    transcribe: true,
    onRecording: (recording) => {
      if (recording.transcription) {
        (mode.command as TranscribeCommandItem).handler?.(
          recording.transcription,
        );
      }
    },
  });

  // Single effect to start recording once
  useEffect(() => {
    startRecording();
    return () => stopRecording();
  }, [startRecording, stopRecording]);

  // Separate effect for keyboard handlers
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter" && isRecording) {
        stopRecording();
      } else if (e.key === "Escape") {
        stopRecording();
        context.setOpen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isRecording, stopRecording, context]);

  return (
    <div className="flex items-center justify-center p-2 gap-2">
      <span
        className={`text-sm ${isRecording ? "text-red-500 animate-pulse" : ""}`}
      >
        {isRecording
          ? <>🎤 Recording... {recordingSeconds}s</>
          : isTranscribing
          ? (
            <div className="flex items-center gap-2">
              <DitheredCube
                width={24}
                height={24}
                animate
                animationSpeed={2}
                cameraZoom={12}
              />
              <span>Transcribing...</span>
            </div>
          )
          : null}
      </span>
      {isRecording && (
        <span className="text-xs text-gray-500">
          Press Enter when done, Esc to cancel
        </span>
      )}
    </div>
  );
}
