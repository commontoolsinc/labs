import React from "react";
import {
  CommonAudioRecording,
  useAudioRecorder,
} from "@/hooks/use-audio-recorder.ts";

interface AudioRecorderProps {
  transcribe?: boolean;
  url?: string;
  onRecording?: (recording: CommonAudioRecording) => void;
  onError?: (error: any) => void;
  startButton?: React.ReactNode;
  stopButton?: React.ReactNode;
  onStreamingTranscription?: (partialTranscription: string) => void;
  initialDelay?: number;
  streamingInterval?: number;
}

const AudioRecorder: React.FC<AudioRecorderProps> = (props) => {
  const { isRecording, recordingSeconds, startRecording, stopRecording } =
    useAudioRecorder(props);

  return (
    <div className="block">
      <div
        className={`${isRecording ? "hidden" : ""}`}
        onClick={startRecording}
      >
        {props.startButton || (
          <button
            type="button"
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Start Recording
          </button>
        )}
      </div>
      <div
        className={`${!isRecording ? "hidden" : ""}`}
        onClick={stopRecording}
      >
        {props.stopButton || (
          <button
            type="button"
            className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600"
          >
            Finish Recording ({recordingSeconds}s)
          </button>
        )}
      </div>
    </div>
  );
};

export default AudioRecorder;
