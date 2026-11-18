import { NextResponse } from "next/server";

export const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, private",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    supportedVersions?: number[];
    retryAfterSeconds?: number;
  };
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extras: Partial<ApiErrorBody["error"]> = {},
) {
  const headers: Record<string, string> = { ...NO_STORE_HEADERS };
  const retryAfterSeconds = extras.retryAfterSeconds;
  if (
    status === 429 &&
    typeof retryAfterSeconds === "number" &&
    Number.isSafeInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0
  ) {
    headers["Retry-After"] = String(Math.min(retryAfterSeconds, 86_400));
  }
  return NextResponse.json<ApiErrorBody>(
    { error: { code, message, ...extras } },
    {
      status,
      headers,
    },
  );
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extras: Partial<ApiErrorBody["error"]> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asApiError(error: unknown) {
  if (error instanceof HttpError) {
    return apiError(error.status, error.code, error.message, error.extras);
  }
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
  const repositoryErrors: Record<string, { status: number; code: string; message: string }> = {
    idempotency_conflict: {
      status: 409,
      code: "idempotency_conflict",
      message: "This idempotency key was already used with a different request.",
    },
    event_id_conflict: {
      status: 409,
      code: "event_id_conflict",
      message: "This event ID was already used with different content.",
    },
    replayed_nonce: {
      status: 409,
      code: "replay_detected",
      message: "This request nonce has already been used.",
    },
    invalid_pairing_code: {
      status: 410,
      code: "pairing_expired",
      message: "Pairing code is expired or was already used.",
    },
    unknown_device: {
      status: 401,
      code: "unauthorized",
      message: "This device is not active on this gateway.",
    },
    device_revoked: { status: 401, code: "unauthorized", message: "This device was revoked." },
    device_scope_denied: {
      status: 403,
      code: "insufficient_scope",
      message: "This device does not have the required grant.",
    },
    unknown_order: { status: 404, code: "not_found", message: "Order was not found." },
    unknown_credit: { status: 404, code: "not_found", message: "Review credit was not found." },
    unknown_receiver_account: { status: 404, code: "not_found", message: "Receiver account was not found." },
    unknown_receiver_profile: { status: 404, code: "not_found", message: "Receiver profile was not found." },
    unknown_pairing_credential: {
      status: 404,
      code: "not_found",
      message: "Pairing credential was not found.",
    },
    invalid_amount: {
      status: 400,
      code: "invalid_request",
      message: "Amount must be positive INR paise within the published limit.",
    },
    invalid_expiry: {
      status: 400,
      code: "invalid_request",
      message: "Order expiry is outside the allowed range.",
    },
    invalid_scopes: {
      status: 400,
      code: "invalid_request",
      message: "At least one supported device grant is required.",
    },
  };
  const mapped = repositoryErrors[code];
  if (mapped) return apiError(mapped.status, mapped.code, mapped.message);
  return apiError(500, "internal_error", "The request could not be completed.");
}

export async function readBoundedBody(request: Request, maxBytes = 32 * 1024): Promise<Buffer> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new HttpError(413, "body_too_large", `Request body must be ${maxBytes} bytes or smaller.`);
  }
  if (!request.body) return Buffer.alloc(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "body_too_large", `Request body must be ${maxBytes} bytes or smaller.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
}

export function parseJsonBody<T>(bytes: Buffer): T {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "invalid_request", "Request body must be valid UTF-8 JSON.");
  }
}

export function requireJsonContentType(request: Request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(400, "invalid_request", "Content-Type must be application/json.");
  }
}

export function requestTarget(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

export function isSameOriginMutation(request: Request, expectedOrigin: string) {
  const origin = request.headers.get("origin");
  if (origin !== expectedOrigin) {
    throw new HttpError(
      403,
      "origin_not_allowed",
      "This request must come from the configured gateway origin.",
    );
  }
}

export function statusForDuplicate(result: { duplicate?: boolean }) {
  return result.duplicate ? 200 : 201;
}
