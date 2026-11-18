import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { loadGatewayConfig } from "@/lib/config";
import type { DeviceScope } from "@/lib/domain/types";
import { readAdminJson } from "@/lib/server/api/admin";
import { apiError, asApiError, HttpError, NO_STORE_HEADERS } from "@/lib/server/api/http";
import { enforceRateLimit } from "@/lib/server/api/rate-limit";
import { pairingCredentialSchema } from "@/lib/server/api/schemas";
import { hashPairingCode } from "@/lib/server/api/signature";
import { getRepository } from "@/lib/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generatePairingCode() {
  const bytes = randomBytes(16);
  const symbols = Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  return (
    symbols
      .join("")
      .match(/.{1,4}/g)
      ?.join("-") ?? symbols.join("")
  );
}

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "admin-pairing-create", 20, 60);
    const { session, data } = await readAdminJson(request, pairingCredentialSchema);
    const now = new Date();
    const code = generatePairingCode();
    const repo = await getRepository();
    const credential = await repo.createPairingCredential({
      codeHash: hashPairingCode(code),
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      grantedScopes: data.grantedScopes as DeviceScope[],
      createdBy: session.adminId,
    });
    return NextResponse.json(
      {
        code,
        gatewayOrigin: loadGatewayConfig().gatewayPublicOrigin,
        expiresAt: credential.expiresAt.toISOString(),
        grantedScopes: credential.grantedScopes,
      },
      { status: 201, headers: { ...NO_STORE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof HttpError) return apiError(error.status, error.code, error.message, error.extras);
    return asApiError(error);
  }
}
