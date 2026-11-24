import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.syncura",
  appName: "Syncura",
  webDir: "dist",
  android: { backgroundColor: "#eff9f7" },
  server: { androidScheme: "https" },
};

export default config;

