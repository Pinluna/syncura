import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface DeviceStatusSnapshot {
  activity: "driving" | "idle" | "walking" | "unknown";
  batteryLevel: number | null;
  isCharging: boolean | null;
  speedMs: number | null;
  stepsToday: number | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  stepSensorAvailable: boolean;
  activityPermission: boolean;
  locationPermission: boolean;
  message?: string;
}

interface DeviceStatusPlugin {
  startTracking(options: { shareLocation: boolean }): Promise<DeviceStatusSnapshot>;
  setLocationSharing(options: { enabled: boolean }): Promise<DeviceStatusSnapshot>;
  getStatus(): Promise<DeviceStatusSnapshot>;
  stopTracking(): Promise<void>;
  addListener(
    eventName: "status",
    listenerFunc: (status: DeviceStatusSnapshot) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "error",
    listenerFunc: (event: { message?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const DeviceStatus = registerPlugin<DeviceStatusPlugin>("DeviceStatus");
