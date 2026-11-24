import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { api } from "../lib/api";
import { DeviceStatus, type DeviceStatusSnapshot } from "../lib/deviceStatus";
import { useSession } from "../lib/session";
import { useToast } from "./ToastProvider";

const MIN_POST_INTERVAL = 10_000;
const HEARTBEAT_INTERVAL = 60_000;

export function DeviceStatusSync() {
  const { me } = useSession();
  const toast = useToast();
  const shareLocation = me?.settings.shareLocation ?? false;
  const shareLocationRef = useRef(shareLocation);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !me?.link?.connected) return;

    let disposed = false;
    let lastSentAt = 0;
    let lastAttemptAt = 0;
    let lastPayload = "";
    let latest: DeviceStatusSnapshot | null = null;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let apiErrorShown = false;
    let errorSubscription: Awaited<ReturnType<typeof DeviceStatus.addListener>> | undefined;
    let statusSubscription: Awaited<ReturnType<typeof DeviceStatus.addListener>> | undefined;

    const send = async () => {
      sendTimer = undefined;
      if (disposed || !latest) return;
      const locationEnabled = shareLocationRef.current;
      const payload: Record<string, unknown> = {
        activity: latest.activity,
        batteryLevel: latest.batteryLevel,
        isCharging: latest.isCharging,
        speedMs: latest.speedMs,
        stepsToday: latest.stepsToday,
      };
      if (locationEnabled) {
        payload.latitude = latest.latitude;
        payload.longitude = latest.longitude;
        payload.accuracyM = latest.accuracyM;
      }

      const serialized = JSON.stringify(payload);
      const now = Date.now();
      if (serialized === lastPayload && now - lastSentAt < HEARTBEAT_INTERVAL) return;
      lastAttemptAt = now;
      try {
        await api.status(payload);
        if (disposed) return;
        lastPayload = serialized;
        lastSentAt = Date.now();
        apiErrorShown = false;
      } catch (error) {
        if (!disposed && !apiErrorShown) {
          apiErrorShown = true;
          toast.error(error instanceof Error ? error.message : "Could not sync device status");
        }
      }
    };

    const queueStatus = (status: DeviceStatusSnapshot) => {
      if (disposed) return;
      latest = status;
      window.dispatchEvent(new CustomEvent("syncura:device-status", { detail: status }));
      if (sendTimer) return;
      const wait = Math.max(0, MIN_POST_INTERVAL - (Date.now() - lastAttemptAt));
      sendTimer = setTimeout(() => void send(), wait);
    };

    const reportError = (message: string) => {
      if (!disposed) toast.error(`Device status: ${message}`);
    };

    void DeviceStatus.addListener("status", queueStatus).then((subscription) => {
      statusSubscription = subscription;
      if (disposed) void subscription.remove();
    });
    void DeviceStatus.addListener("error", (event) => {
      reportError(event.message || "Tracking failed");
    }).then((subscription) => {
      errorSubscription = subscription;
      if (disposed) void subscription.remove();
    });

    void DeviceStatus.startTracking({ shareLocation: shareLocationRef.current })
      .then(queueStatus)
      .catch((error: unknown) => {
        reportError(error instanceof Error ? error.message : "Could not start tracking");
      });

    heartbeat = setInterval(() => {
      void DeviceStatus.getStatus().then(queueStatus).catch((error: unknown) => {
        reportError(error instanceof Error ? error.message : "Could not read device status");
      });
    }, HEARTBEAT_INTERVAL);

    return () => {
      disposed = true;
      if (sendTimer) clearTimeout(sendTimer);
      if (heartbeat) clearInterval(heartbeat);
      if (statusSubscription) void statusSubscription.remove();
      if (errorSubscription) void errorSubscription.remove();
      void DeviceStatus.stopTracking();
    };
  }, [me?.link?.connected, toast]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !me?.link?.connected) return;
    const updateLocationSharing = (enabled: boolean) => {
      shareLocationRef.current = enabled;
      void DeviceStatus.setLocationSharing({ enabled })
        .then((status) =>
          window.dispatchEvent(new CustomEvent("syncura:device-status", { detail: status })),
        )
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Could not update location sharing");
        });
    };
    updateLocationSharing(shareLocation);
    const onSharingChanged = (event: Event) =>
      updateLocationSharing((event as CustomEvent<boolean>).detail);
    window.addEventListener("syncura:location-sharing", onSharingChanged);
    return () => window.removeEventListener("syncura:location-sharing", onSharingChanged);
  }, [me?.link?.connected, shareLocation, toast]);

  return null;
}
