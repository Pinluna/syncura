import { createSign } from "node:crypto";
import type { User } from "./store.js";
import { save } from "./store.js";

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let accessToken: string | null = null;
let accessTokenExpiresAt = 0;

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function serviceAccount(): ServiceAccount | null {
  const source = process.env.SYNCURA_FCM_SERVICE_ACCOUNT;
  if (!source) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error("SYNCURA_FCM_SERVICE_ACCOUNT must contain service-account JSON", { cause: error });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("project_id" in parsed) ||
    typeof parsed.project_id !== "string" ||
    !("client_email" in parsed) ||
    typeof parsed.client_email !== "string" ||
    !("private_key" in parsed) ||
    typeof parsed.private_key !== "string"
  ) {
    throw new Error("SYNCURA_FCM_SERVICE_ACCOUNT is missing required credentials");
  }
  return parsed as ServiceAccount;
}

async function firebaseAccessToken(account: ServiceAccount): Promise<string> {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) return accessToken;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(account.private_key.replace(/\\n/g, "\n")).toString("base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Firebase token request failed with HTTP ${response.status}`);
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("access_token" in result) ||
    typeof result.access_token !== "string" ||
    !("expires_in" in result) ||
    typeof result.expires_in !== "number"
  ) {
    throw new Error("Firebase token response was invalid");
  }
  accessToken = result.access_token;
  accessTokenExpiresAt = Date.now() + result.expires_in * 1000;
  return accessToken;
}

export async function notifyIncomingMessage(recipient: User, senderName: string): Promise<void> {
  const account = serviceAccount();
  if (!account || !recipient.pushTokens?.length) return;

  const token = await firebaseAccessToken(account);
  const invalidTokens: string[] = [];
  await Promise.all(
    recipient.pushTokens.map(async (deviceToken) => {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: {
                title: "New Syncura message",
                body: `${senderName} sent you a message`,
              },
              android: {
                priority: "HIGH",
                notification: {
                  channel_id: "syncura_messages",
                  sound: "syncura_message_tone",
                  icon: "ic_stat_syncura",
                },
              },
              data: { type: "chat_message" },
            },
          }),
        },
      );
      if (response.ok) return;
      const details: unknown = await response.json().catch(() => null);
      const errorStatus =
        typeof details === "object" && details !== null && "error" in details &&
        typeof details.error === "object" && details.error !== null &&
        "details" in details.error && Array.isArray(details.error.details)
          ? details.error.details.find(
              (detail: unknown) =>
                typeof detail === "object" && detail !== null &&
                "errorCode" in detail && typeof detail.errorCode === "string",
            )
          : null;
      const code =
        typeof errorStatus === "object" && errorStatus !== null && "errorCode" in errorStatus
          ? errorStatus.errorCode
          : null;
      if (code === "UNREGISTERED" || response.status === 404) {
        invalidTokens.push(deviceToken);
      } else {
        console.error(`Firebase message delivery failed with HTTP ${response.status}`);
      }
    }),
  );
  if (invalidTokens.length) {
    recipient.pushTokens = recipient.pushTokens.filter((deviceToken) => !invalidTokens.includes(deviceToken));
    save();
  }
}
