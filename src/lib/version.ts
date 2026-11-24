import pkg from "../../package.json";

/* One place for the number people see in Settings, so it cannot drift from the
   package, the APK and the manifest. */
export const APP_VERSION: string = pkg.version;
