import { NextResponse } from "next/server";
import { loadGatewayConfig } from "@/lib/config";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { receiverAccountSchema } from "@/lib/server/api/schemas";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { session, data } = await readAdminJson(request, receiverAccountSchema);
    const config = loadGatewayConfig();
    if (data.payeeVpa.toLowerCase() !== config.upiPayeeVpa.toLowerCase()) {
      throw new HttpError(
        400,
        "invalid_request",
        "Receiver account must match this installation's configured UPI_PAYEE_VPA.",
      );
    }
    const repo = await getRepository();
    const account = await repo.createReceiverAccount({
      label: data.label,
      payeeVpa: config.upiPayeeVpa,
      verifiedBy: session.adminId,
      verified: true,
    });
    return NextResponse.json(
      {
        id: account.id,
        label: account.label,
        payeeVpa: account.payeeVpa,
        verifiedAt: account.verifiedAt?.toISOString() ?? null,
      },
      { status: 201, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}
