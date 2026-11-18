import { NextResponse } from "next/server";
import { loadGatewayConfig } from "@/lib/config";
import { receiverProfilesResponse } from "@/lib/observer/receiver-profiles";
import {
  apiError,
  asApiError,
  HttpError,
  NO_STORE_HEADERS,
  requireEmptyRequestBody,
} from "@/lib/server/api/http";
import { enforceDeviceRateLimit } from "@/lib/server/api/rate-limit";
import { authenticateSignedDevice, ensureApiVersion } from "@/lib/server/api/signature";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    ensureApiVersion(request);
    await requireEmptyRequestBody(request);
    const { device } = await authenticateSignedDevice({
      request,
      body: Buffer.alloc(0),
      requiredScope: "observations",
    });
    await enforceDeviceRateLimit(device.id, "device-receiver-profile-discovery", 120, 60);
    const config = loadGatewayConfig();
    const repo = await getRepository();
    const profiles = await repo.listDeviceReceiverProfiles(device.id, config.upiPayeeVpa);
    return NextResponse.json(receiverProfilesResponse(config.gatewayPublicOrigin, profiles), {
      status: 200,
      headers: { ...NO_STORE_HEADERS },
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return apiError(error.status, error.code, error.message, error.extras);
    }
    return asApiError(error);
  }
}
