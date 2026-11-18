import { NextResponse } from "next/server";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { receiverProfileSchema } from "@/lib/server/api/schemas";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { data } = await readAdminJson(request, receiverProfileSchema);
    if (data.source === "bank_sms" && !data.sourceTemplateId) {
      throw new HttpError(
        400,
        "invalid_request",
        "Bank SMS profiles require an approved sender/template identity.",
      );
    }
    const repo = await getRepository();
    const profile = await repo.createReceiverProfile({
      receiverAccountId: data.receiverAccountId,
      deviceId: data.deviceId,
      source: data.source,
      sourceTemplateId: data.sourceTemplateId ?? null,
    });
    return NextResponse.json(
      {
        id: profile.id,
        receiverAccountId: profile.receiverAccountId,
        deviceId: profile.deviceId,
        source: profile.source,
        sourceTemplateId: profile.sourceTemplateId,
        active: profile.active,
      },
      { status: 201, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}
