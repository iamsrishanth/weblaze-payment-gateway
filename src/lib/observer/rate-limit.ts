import { createHmac } from "node:crypto";

export function deviceRateKey(deviceId: string, namespace: string, secret: string) {
  return createHmac("sha256", secret).update(`${namespace}\n${deviceId}`, "utf8").digest("hex");
}
