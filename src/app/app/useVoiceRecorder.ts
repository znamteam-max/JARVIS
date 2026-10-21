"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// A spoken question longer than this is cut and sent as is.
const MAX_SECONDS = 120;
// What the browser can record, in order of preference (Safari/iOS only does mp4).
const TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

const NO_MIC =
  "Здесь микрофон недоступен. Надиктуй голосовое прямо боту в Telegram — он поймёт, или открой JARVIS в браузере.";
const DENIED = "Нет доступа к микрофону. Разреши его для JARVIS и попробуй ещё раз.";
const TOO_SHORT = "Запись получилась слишком короткой — скажи ещё раз.";

export type VoiceRecorder = {
  recording: boolean;
  seconds: number;
  error: string | null;
  // Starts recording, or stops it and hands the audio over.
  toggle: () => void;
  cancel: () => void;
};

// Press to talk, press again to send: the recording goes to `onDone` as one audio blob.
export function useVoiceRecorder(onDone: (audio: Blob) => void): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const cancelledRef = useRef(false);
  const aliveRef = useRef(true);
  const doneRef = useRef(onDone);

  useEffect(() => {
    doneRef.current = onDone;
  }, [onDone]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError(NO_MIC);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (aliveRef.current) setError(DENIED);
      return;
    }
    // The screen was closed while the phone asked for the microphone: let it go at once.
    if (!aliveRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mimeType = TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      setRecording(false);
      if (cancelledRef.current) return;
      const audio = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      if (audio.size < 1000) {
        setError(TOO_SHORT);
        return;
      }
      doneRef.current(audio);
    };
    cancelledRef.current = false;
    recorderRef.current = recorder;
    recorder.start();
    setSeconds(0);
    setRecording(true);
  }, []);

  // The timer on screen, and the cut-off.
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setSeconds((current) => {
        if (current + 1 >= MAX_SECONDS) stop();
        return current + 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording, stop]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  // Leaving the screen mid-recording sends nothing and frees the microphone.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cancel();
    };
  }, [cancel]);

  const toggle = useCallback(() => {
    if (recorderRef.current) stop();
    else void start();
  }, [start, stop]);

  return { recording, seconds, error, toggle, cancel };
}

export function recordingTime(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
