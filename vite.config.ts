import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3001";
const firebaseConfigPath = fileURLToPath(new URL("./android/app/google-services.json", import.meta.url));

export default defineConfig({
  plugins: [react()],
  define: {
    __SYNCURA_FCM_CONFIGURED__: JSON.stringify(existsSync(firebaseConfigPath)),
  },
  server: {
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true, secure: false },
      "/socket.io": { target: apiTarget, ws: true, secure: false },
    },
  },
});
