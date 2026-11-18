import type { DiscoveredReceiverProfile } from "@/lib/domain/types";
import { isValidSourceTemplateId } from "@/lib/observer/source-template";

export interface ReceiverProfilesResponse {
  apiVersion: "1.0.0";
  gatewayOrigin: string;
  receiverProfiles: DiscoveredReceiverProfile[];
}

const SAFE_DISPLAY_NAME = /^[\p{L}\p{M} .,\u2019'()&:/-]{1,80}$/u;

export function sanitizeReceiverDisplayName(value: string) {
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    return "Verified receiving account";
  }
  const label = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!SAFE_DISPLAY_NAME.test(label)) return "Verified receiving account";
  return label;
}

export function receiverProfilesResponse(
  gatewayOrigin: string,
  receiverProfiles: DiscoveredReceiverProfile[],
): ReceiverProfilesResponse {
  const url = new URL(gatewayOrigin);
  if (url.origin !== gatewayOrigin || !["https:", "http:"].includes(url.protocol)) {
    throw new Error("Receiver profile discovery requires a validated gateway origin.");
  }
  return {
    apiVersion: "1.0.0",
    gatewayOrigin: url.origin,
    receiverProfiles: receiverProfiles
      .filter((profile) =>
        profile.source === "phonepe"
          ? profile.sourceTemplateId === null
          : profile.source === "bank_sms" && isValidSourceTemplateId(profile.sourceTemplateId ?? ""),
      )
      .map((profile) => ({
        id: profile.id,
        source: profile.source,
        displayName: sanitizeReceiverDisplayName(profile.displayName),
        maskedAccountSuffix:
          profile.maskedAccountSuffix &&
          profile.maskedAccountSuffix.length === 4 &&
          /^[0-9]{4}$/.test(profile.maskedAccountSuffix)
            ? profile.maskedAccountSuffix
            : null,
        sourceTemplateId: profile.sourceTemplateId,
      })),
  };
}
