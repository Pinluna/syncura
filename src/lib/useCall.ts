import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { sendCallSignal, subscribeRealtime, type CallSignal } from "./realtime";

export type CallMode = "audio" | "video";
export type CallPhase = "idle" | "calling" | "incoming" | "connecting" | "active" | "error";

interface ActiveCall {
  id: string;
  mode: CallMode;
  peer: RTCPeerConnection;
}

interface PendingOffer {
  id: string;
  mode: CallMode;
  description: RTCSessionDescriptionInit;
}

function isDescription(value: unknown): value is RTCSessionDescriptionInit {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "offer" || value.type === "answer") &&
    "sdp" in value &&
    typeof value.sdp === "string"
  );
}

function isCandidate(value: unknown): value is RTCIceCandidateInit {
  return (
    typeof value === "object" &&
    value !== null &&
    "candidate" in value &&
    typeof value.candidate === "string"
  );
}

export function useCall(_partnerName?: string | null) {
  void _partnerName;
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [mode, setMode] = useState<CallMode>("audio");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<ActiveCall | null>(null);
  const pendingOffer = useRef<PendingOffer | null>(null);
  const pendingCandidates = useRef<RTCIceCandidateInit[]>([]);

  const reset = useCallback(() => {
    const call = active.current;
    active.current = null;
    pendingOffer.current = null;
    pendingCandidates.current = [];
    call?.peer.getSenders().forEach((sender) => sender.track?.stop());
    call?.peer.close();
    setLocalStream(null);
    setRemoteStream(null);
    setPhase("idle");
  }, []);

  const attachCandidates = useCallback(async (peer: RTCPeerConnection) => {
    const queued = pendingCandidates.current;
    pendingCandidates.current = [];
    for (const candidate of queued) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (candidateError) {
        console.warn("Could not add a queued call candidate", candidateError);
      }
    }
  }, []);

  const makePeer = useCallback(
    (id: string, callMode: CallMode, stream: MediaStream, iceServers: RTCIceServer[]) => {
      const peer = new RTCPeerConnection({ iceServers });
      active.current = { id, mode: callMode, peer };
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      peer.ontrack = (event) => {
        if (event.streams[0]) {
          setRemoteStream(event.streams[0]);
        } else {
          setRemoteStream((current) => {
            const combined = current ?? new MediaStream();
            combined.addTrack(event.track);
            return combined;
          });
        }
      };
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          sendCallSignal({
            callId: id,
            kind: "ice",
            data: event.candidate.toJSON(),
          });
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") setPhase("active");
        if (peer.connectionState === "failed") {
          setError("The call could not connect. Check the server's WebRTC ICE/TURN settings.");
          setPhase("error");
        }
      };
      return peer;
    },
    [],
  );

  const handleSignal = useCallback(
    (signal: CallSignal) => {
      if (signal.kind === "offer") {
        if (
          active.current ||
          pendingOffer.current ||
          !isDescription(signal.data) ||
          (signal.mode !== "audio" && signal.mode !== "video")
        ) {
          if (active.current || pendingOffer.current) {
            sendCallSignal({ callId: signal.callId, kind: "end" });
          }
          return;
        }
        pendingOffer.current = {
          id: signal.callId,
          mode: signal.mode,
          description: signal.data,
        };
        pendingCandidates.current = [];
        setMode(signal.mode);
        setError(null);
        setPhase("incoming");
        return;
      }

      const call = active.current;
      if (signal.kind === "end") {
        if (call?.id === signal.callId || pendingOffer.current?.id === signal.callId) reset();
        return;
      }
      if (signal.kind === "ice") {
        if (!isCandidate(signal.data)) return;
        if (!call || call.id !== signal.callId || !call.peer.remoteDescription) {
          if (pendingOffer.current?.id === signal.callId) pendingCandidates.current.push(signal.data);
          return;
        }
        void call.peer.addIceCandidate(signal.data).catch((candidateError) => {
          console.warn("Could not add a call candidate", candidateError);
        });
        return;
      }
      if (signal.kind === "answer" && call?.id === signal.callId && isDescription(signal.data)) {
        void call.peer
          .setRemoteDescription(signal.data)
          .then(() => attachCandidates(call.peer))
          .then(() => setPhase("connecting"))
          .catch((answerError: unknown) => {
            setError(answerError instanceof Error ? answerError.message : "Could not connect this call");
            setPhase("error");
          });
      }
    },
    [attachCandidates, reset],
  );

  useEffect(() => {
    const unsubscribe = subscribeRealtime({ onCallSignal: handleSignal });
    return () => {
      unsubscribe();
      const callId = active.current?.id ?? pendingOffer.current?.id;
      if (callId) sendCallSignal({ callId, kind: "end" });
      const call = active.current;
      active.current = null;
      pendingOffer.current = null;
      call?.peer.getSenders().forEach((sender) => sender.track?.stop());
      call?.peer.close();
    };
  }, [handleSignal]);

  const start = useCallback(
    async (callMode: CallMode) => {
      if (active.current || pendingOffer.current) return;
      setError(null);
      setMode(callMode);
      setPhase("calling");
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("This browser does not support audio or video calls");
        }
        const [stream, { iceServers }] = await Promise.all([
          navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callMode === "video",
          }),
          api.callIceServers(),
        ]);
        const id = crypto.randomUUID();
        setLocalStream(stream);
        const peer = makePeer(id, callMode, stream, iceServers);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        if (!peer.localDescription) throw new Error("Could not create a call offer");
        sendCallSignal({
          callId: id,
          kind: "offer",
          mode: callMode,
          data: peer.localDescription.toJSON(),
        });
        setPhase("connecting");
      } catch (callError) {
        reset();
        setError(callError instanceof Error ? callError.message : "Could not start the call");
        setPhase("error");
      }
    },
    [makePeer, reset],
  );

  const accept = useCallback(async () => {
    const offer = pendingOffer.current;
    if (!offer) return;
    setPhase("connecting");
    setError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support audio or video calls");
      }
      const [stream, { iceServers }] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          audio: true,
          video: offer.mode === "video",
        }),
        api.callIceServers(),
      ]);
      setLocalStream(stream);
      const peer = makePeer(offer.id, offer.mode, stream, iceServers);
      await peer.setRemoteDescription(offer.description);
      await attachCandidates(peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (!peer.localDescription) throw new Error("Could not answer this call");
      pendingOffer.current = null;
      sendCallSignal({
        callId: offer.id,
        kind: "answer",
        data: peer.localDescription.toJSON(),
      });
    } catch (callError) {
      reset();
      setError(callError instanceof Error ? callError.message : "Could not answer this call");
      setPhase("error");
    }
  }, [attachCandidates, makePeer, reset]);

  const end = useCallback(() => {
    const callId = active.current?.id ?? pendingOffer.current?.id;
    if (callId) sendCallSignal({ callId, kind: "end" });
    reset();
    setError(null);
  }, [reset]);

  const dismissError = useCallback(() => {
    setError(null);
    setPhase("idle");
  }, []);

  const decline = useCallback(() => {
    end();
  }, [end]);

  return {
    phase,
    mode,
    localStream,
    remoteStream,
    error,
    start,
    accept,
    decline,
    end,
    dismissError,
  };
}
