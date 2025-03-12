import { useCallback, useEffect, useRef, useState } from "react";

interface AudioRecorderOptions {
  transcribe?: boolean;
  url?: string;
  onRecording?: (recording: CommonAudioRecording) => void;
  onError?: (error: any) => void;
}

export interface CommonAudioRecording {
  id: string;
  blob: Blob;
  transcription?: string;
}

export function useAudioRecorder({
  transcribe = false,
  url = "/api/ai/voice/transcribe",
  onRecording,
  onError,
}: AudioRecorderOptions = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number | null>(null);
  const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);

  const updateRecordingTime = useCallback(() => {
    if (!startTimeRef.current) return;
    const delta = Math.floor((Date.now() - startTimeRef.current) / 1000);
    setRecordingSeconds(delta);
  }, []);

  const cleanupRecording = useCallback(() => {
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }

    if (activeStreamRef.current) {
      activeStreamRef.current.getTracks().forEach((track) => track.stop());
      activeStreamRef.current = null;
    }

    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current as unknown as number);
      recordingTimerRef.current = null;
    }

    startTimeRef.current = null;
    setRecordingSeconds(0);
    setIsRecording(false);
  }, []);

  const runFinalTranscription = useCallback(async (audioBlob: Blob) => {
    if (!transcribe || !url) return;

    try {
      setIsTranscribing(true);
      const response = await fetch(url, {
        method: "POST",
        body: audioBlob,
      });
      const data = await response.json();

      onRecording?.({
        id: crypto.randomUUID(),
        blob: audioBlob,
        transcription: data.transcription,
      });
    } catch (error) {
      console.error("Transcription error:", error);
      onError?.({ error, blob: audioBlob });
    } finally {
      setIsTranscribing(false);
    }
  }, [transcribe, url, onRecording, onError]);

  const startRecording = useCallback(async () => {
    console.log("Starting recording...");

    cleanupRecording();

    try {
      console.log("Requesting microphone access...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      activeStreamRef.current = stream;
      console.log("Microphone access granted");

      console.log("Creating MediaRecorder...");
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      startTimeRef.current = Date.now();
      setRecordingSeconds(0);
      console.log("MediaRecorder created");

      mediaRecorder.ondataavailable = (event) => {
        console.log(`Data available event, size: ${event.data.size}`);
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          console.log(
            `Chunk added, total chunks: ${audioChunksRef.current.length}`,
          );
        }
      };

      mediaRecorder.onstop = async () => {
        console.log("MediaRecorder stopped");
        if (audioChunksRef.current.length === 0) {
          console.log("No audio chunks recorded, skipping processing");
          return;
        }

        console.log(
          `Creating blob from ${audioChunksRef.current.length} chunks`,
        );
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/wav",
        });
        console.log(`Blob created, size: ${audioBlob.size}`);

        try {
          if (transcribe) {
            console.log("Running final transcription...");
            setIsTranscribing(true);
            await runFinalTranscription(audioBlob);
          } else {
            console.log("Transcribe disabled, returning raw audio");
            onRecording?.({
              id: crypto.randomUUID(),
              blob: audioBlob,
            });
          }
        } finally {
          setIsTranscribing(false);
          mediaRecorderRef.current = null;
        }
      };

      console.log("Starting MediaRecorder with 1s interval");
      mediaRecorder.start(1000);
      setIsRecording(true);
      console.log("Recording started");

      console.log("Setting up recording timer");
      recordingTimerRef.current = setInterval(
        updateRecordingTime,
        100,
      ) as unknown as NodeJS.Timeout;
      console.log("Timer started");
    } catch (error: any) {
      cleanupRecording();
      console.error("Error in startRecording:", error);
      console.error("Full error details:", {
        name: error.name,
        message: error.message,
        stack: error.stack,
      });
      onError?.(error);
    }
  }, [
    cleanupRecording,
    transcribe,
    onRecording,
    onError,
    runFinalTranscription,
    updateRecordingTime,
  ]);

  const stopRecording = useCallback(() => {
    console.log("Stopping recording...");
    if (
      mediaRecorderRef.current && mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
    }
    cleanupRecording();
  }, [cleanupRecording]);

  useEffect(() => {
    return () => {
      cleanupRecording();
    };
  }, [cleanupRecording]);

  return {
    isRecording,
    isTranscribing,
    recordingSeconds,
    startRecording,
    stopRecording,
  };
}
