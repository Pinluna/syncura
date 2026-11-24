import { useEffect } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { PushNotifications } from "@capacitor/push-notifications";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { navigate } from "../lib/router";

const CHANNEL_ID = "syncura_messages";
const MESSAGE_SOUND = "syncura_message_tone.wav";

export function PushRegistration() {
  const { me } = useSession();

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !me?.link?.connected) return;
    let active = true;
    const listeners: PluginListenerHandle[] = [];

    const register = async () => {
      try {
        const permission = await PushNotifications.checkPermissions();
        const granted =
          permission.receive === "granted"
            ? permission
            : permission.receive === "prompt"
              ? await PushNotifications.requestPermissions()
              : null;
        if (!granted || granted.receive !== "granted" || !active) return;

        if (Capacitor.getPlatform() === "android") {
          await PushNotifications.createChannel({
            id: CHANNEL_ID,
            name: "Chat messages",
            description: "New messages from your partner",
            importance: 5,
            visibility: 1,
            sound: "syncura_message_tone",
            vibration: true,
          });
          await LocalNotifications.createChannel({
            id: CHANNEL_ID,
            name: "Chat messages",
            description: "New messages from your partner",
            importance: 5,
            sound: MESSAGE_SOUND,
            vibration: true,
          });
        }

        listeners.push(
          await PushNotifications.addListener("registration", ({ value }) => {
            if (active) {
              void api.registerPushToken(value).catch((error: unknown) => {
                console.error("Could not register this device for message notifications", error);
              });
            }
          }),
          await PushNotifications.addListener("registrationError", (error) => {
            console.error("Push notification registration failed", error);
          }),
          await PushNotifications.addListener("pushNotificationReceived", (notification) => {
            if (!active) return;
            void LocalNotifications.schedule({
              notifications: [
                {
                  id: Math.floor(Date.now() % 2_000_000_000),
                  title: notification.title ?? "New Syncura message",
                  body: notification.body ?? "You received a new message",
                  channelId: CHANNEL_ID,
                  sound: MESSAGE_SOUND,
                  smallIcon: "ic_stat_syncura",
                  iconColor: "#66e6bc",
                },
              ],
            }).catch((error: unknown) => {
              console.error("Could not show a foreground message notification", error);
            });
          }),
          await PushNotifications.addListener("pushNotificationActionPerformed", () => {
            navigate("/chat");
          }),
          await LocalNotifications.addListener("localNotificationActionPerformed", () => {
            navigate("/chat");
          }),
        );

        await PushNotifications.register();
      } catch (error) {
        console.error("Could not initialize push notifications", error);
      }
    };

    void register();
    return () => {
      active = false;
      listeners.forEach((listener) => void listener.remove());
    };
  }, [me?.link?.id, me?.link?.connected]);

  return null;
}
