import { useEffect } from 'react';
import { useAudioRecorder } from '@/hooks/use-audio-recorder';
import { CommandContext, CommandItem } from './commands';

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
    stopRecording
  } = useAudioRecorder({
    transcribe: true,
    onRecording: (recording) => {
      if (recording.transcription) {
        mode.command.handler?.(context, recording.transcription);
      }
    }
  });

  // Single effect to start recording once
  useEffect(() => {
    startRecording();
    return () => stopRecording();
  }, []); // Empty dependency array - only run once

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
      <span className="text-sm text-red-500 animate-pulse">
        {isRecording ? (
          <>🎤 Recording... {recordingSeconds}s</>
        ) : isTranscribing ? (
          <>✍️ Transcribing...</>
        ) : null}
      </span>
      {isRecording && (
        <span className="text-xs text-gray-500">
          Press Enter when done, Esc to cancel
        </span>
      )}
    </div>
  );
}
