/* Call alerts: what rings, what buzzes, and how the app stays reachable.

   Chat messages and calls travel over a Socket.IO connection, so the app's
   process has to stay alive for either to arrive while the app is closed. The
   native side keeps it alive with a low-importance foreground service; this
   module is the web side of that, plus the user's ringtone and vibration
   choices.

   The choices are mirrored into native SharedPreferences by CallAlertsPlugin
   because the ringing screen is an Android activity, not part of the page -- it
   cannot read localStorage. Every function here degrades to a no-op on the web,
   where none of it exists. */
import { Capacitor, registerPlugin } from "@capacitor/core";

export interface CallAlertPreferences {
  enabled: boolean;
  vibrate: boolean;
  ringtoneUri: string;
  systemRingtoneName: string;
}

interface CallAlertsPluginShape {
  getPreferences(): Promise<CallAlertPreferences>;
  setVibrate(options: { enabled: boolean }): Promise<void>;
  setEnabled(options: { enabled: boolean }): Promise<void>;
  pickRingtone(): Promise<{ ringtoneUri?: string; ringtoneName?: string }>;
  openNotificationSettings(): Promise<void>;
  setKeepAlive(options: { enabled: boolean }): Promise<void>;
}

const CallAlerts = registerPlugin<CallAlertsPluginShape>("CallAlerts");

const isNative = Capacitor.isNativePlatform();

export const DEFAULT_RINGTONE_NAME = "System default";

/** Native-only. On the web there is no plugin and nothing to keep alive. */
export function isCallAlertsAvailable(): boolean {
  return isNative;
}

export async function readCallPreferences(): Promise<CallAlertPreferences> {
  if (!isNative) {
    return { enabled: false, vibrate: true, ringtoneUri: "", systemRingtoneName: DEFAULT_RINGTONE_NAME };
  }
  try {
    return await CallAlerts.getPreferences();
  } catch (error) {
    console.error("Could not read the call preferences", error);
    return { enabled: true, vibrate: true, ringtoneUri: "", systemRingtoneName: DEFAULT_RINGTONE_NAME };
  }
}

export async function setCallVibration(enabled: boolean): Promise<void> {
  if (!isNative) return;
  try {
    await CallAlerts.setVibrate({ enabled });
  } catch (error) {
    console.error("Could not save the call vibration setting", error);
  }
}

export async function setCallAlertsEnabled(enabled: boolean): Promise<void> {
  if (!isNative) return;
  try {
    await CallAlerts.setEnabled({ enabled });
  } catch (error) {
    console.error("Could not save the call alert setting", error);
  }
}

/**
 * Opens the phone's own ringtone picker, so every sound in the library shows up
 * -- including ones downloaded later -- with nothing allow-listed here. Returns
 * the stored preferences after the pick, or null if the person cancelled.
 */
export async function pickCallRingtone(): Promise<CallAlertPreferences | null> {
  if (!isNative) return null;
  try {
    const result = await CallAlerts.pickRingtone();
    if (!result?.ringtoneUri) return null;
    return await readCallPreferences();
  } catch (error) {
    console.error("Could not open the ringtone picker", error);
    return null;
  }
}

export async function openNotificationSettings(): Promise<void> {
  if (!isNative) return;
  try {
    await CallAlerts.openNotificationSettings();
  } catch (error) {
    console.error("Could not open the notification settings", error);
  }
}

/**
 * Turns the process keep-alive on or off.
 *
 * Started once a session exists, because it is what makes messages and calls
 * reach the phone with the app closed; stopped on sign-out so a signed-out app
 * is not holding a connection open.
 */
export async function setKeepAlive(enabled: boolean): Promise<void> {
  if (!isNative) return;
  try {
    await CallAlerts.setKeepAlive({ enabled });
  } catch (error) {
    console.error("Could not change the background connection", error);
  }
}