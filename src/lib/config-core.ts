import { isIP } from "node:net";
import { containsControlCharacters } from "@/lib/observer/validation";

type Environment = Record<string, string | undefined>;

export interface GatewayConfig {
  nodeEnv: "development" | "test" | "production";
  merchantDisplayName: string;
  gatewayPublicOrigin: string;
  upiPayeeVpa: string;
  databaseUrl: string;
  merchantApiKey: string;
  sessionSecret: string;
  orderTokenSecret: string;
}

export interface BootstrapConfig {
  email: string;
  password: string;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const PLACEHOLDER_MARKERS = [
  "example",
  "sample",
  "synthetic",
  "placeholder",
  "password",
  "replace-with",
  "replace_me",
  "changeme",
  "your-",
  "your_",
  "<your",
  "demo-only",
];
const RESERVED_HOST_SUFFIXES = [".test", ".example", ".invalid"];
const RESERVED_HOSTS = new Set(["example", "invalid", "test", "example.com", "example.net", "example.org"]);
const PRIVATE_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "db",
  "postgres",
]);

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigurationError(`Missing required setting: ${name}`);
  return value;
}

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker));
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

function isReservedHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    isPlaceholder(normalized) ||
    RESERVED_HOSTS.has(normalized) ||
    RESERVED_HOST_SUFFIXES.some((suffix) => normalized.endsWith(suffix)) ||
    ["example.com", "example.net", "example.org"].some((domain) => normalized.endsWith(`.${domain}`)) ||
    PRIVATE_HOSTS.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    isIP(normalized) !== 0
  );
}

function validCanonicalOrigin(value: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("GATEWAY_PUBLIC_ORIGIN must be an absolute origin URL");
  }

  const localDevOrigin =
    !production && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (!production && url.protocol !== "https:" && !localDevOrigin) ||
    (production && url.protocol !== "https:")
  ) {
    throw new ConfigurationError(
      "GATEWAY_PUBLIC_ORIGIN must use HTTPS (HTTP is allowed only for local development)",
    );
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw new ConfigurationError(
      "GATEWAY_PUBLIC_ORIGIN must be a canonical origin without credentials, path, query, fragment, or trailing slash",
    );
  }
  if (production) {
    if (url.hostname.endsWith(".")) {
      throw new ConfigurationError(
        "GATEWAY_PUBLIC_ORIGIN must be canonical and must not end with a trailing dot",
      );
    }
    if (isReservedHostname(url.hostname)) {
      throw new ConfigurationError("GATEWAY_PUBLIC_ORIGIN must use a real public DNS hostname in production");
    }
  }
  return url.origin;
}

function validDatabaseUrl(value: string, production: boolean, allowPrivateHost: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("DATABASE_URL must be a PostgreSQL connection URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname ||
    url.pathname === "/"
  ) {
    throw new ConfigurationError("DATABASE_URL must use postgres:// or postgresql:// and name a database");
  }
  if (production) {
    let username: string;
    let password: string;
    try {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      throw new ConfigurationError("DATABASE_URL credentials must be valid URL-encoded values");
    }
    if (!username || password.length < 16 || isPlaceholder(username) || isPlaceholder(password)) {
      throw new ConfigurationError(
        "DATABASE_URL must contain non-placeholder production database credentials",
      );
    }
    const normalizedHost = normalizeHostname(url.hostname);
    if (
      isPlaceholder(normalizedHost) ||
      RESERVED_HOSTS.has(normalizedHost) ||
      RESERVED_HOST_SUFFIXES.some((suffix) => normalizedHost.endsWith(suffix)) ||
      ["example.com", "example.net", "example.org"].some((domain) => normalizedHost.endsWith(`.${domain}`))
    ) {
      throw new ConfigurationError("DATABASE_URL must use a real PostgreSQL host in production");
    }
    const privateHost =
      isIP(normalizedHost) !== 0 ||
      PRIVATE_HOSTS.has(normalizedHost) ||
      normalizedHost.endsWith(".localhost") ||
      normalizedHost.endsWith(".local") ||
      normalizedHost.endsWith(".internal");
    if (privateHost && !allowPrivateHost) {
      throw new ConfigurationError(
        "DATABASE_URL must use a reachable DNS hostname in production unless ALLOW_PRIVATE_DATABASE_HOST=true is explicitly set for Compose",
      );
    }
  }
  return value;
}

function validSecret(env: Environment, name: string, production: boolean): string {
  const value = required(env, name);
  if (value.length < 32) throw new ConfigurationError(`${name} must contain at least 32 characters`);
  if (production && (isPlaceholder(value) || new Set(value).size < 16)) {
    throw new ConfigurationError(`${name} must be replaced with a unique random production secret`);
  }
  return value;
}

export function loadGatewayConfig(env: Environment = process.env): GatewayConfig {
  const rawEnvironment = env.NODE_ENV ?? "development";
  if (!["development", "test", "production"].includes(rawEnvironment)) {
    throw new ConfigurationError("NODE_ENV must be development, test, or production");
  }
  const nodeEnv = rawEnvironment as GatewayConfig["nodeEnv"];
  const production = nodeEnv === "production";
  const allowPrivateDatabaseHost = env.ALLOW_PRIVATE_DATABASE_HOST === "true";
  if (
    env.ALLOW_PRIVATE_DATABASE_HOST !== undefined &&
    !["true", "false"].includes(env.ALLOW_PRIVATE_DATABASE_HOST)
  ) {
    throw new ConfigurationError("ALLOW_PRIVATE_DATABASE_HOST must be true or false when set");
  }
  const merchantDisplayName = required(env, "MERCHANT_DISPLAY_NAME");
  if (merchantDisplayName.length > 80 || containsControlCharacters(merchantDisplayName)) {
    throw new ConfigurationError("MERCHANT_DISPLAY_NAME must be 1 to 80 printable characters");
  }
  if (production && isPlaceholder(merchantDisplayName)) {
    throw new ConfigurationError(
      "MERCHANT_DISPLAY_NAME must be a real configured merchant label in production",
    );
  }
  const gatewayPublicOrigin = validCanonicalOrigin(required(env, "GATEWAY_PUBLIC_ORIGIN"), production);

  const upiPayeeVpa = required(env, "UPI_PAYEE_VPA");
  if (
    upiPayeeVpa.length > 255 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}@[A-Za-z0-9][A-Za-z0-9.-]{1,80}$/.test(upiPayeeVpa)
  ) {
    throw new ConfigurationError("UPI_PAYEE_VPA must be a valid UPI address in localpart@handle form");
  }
  if (production && isPlaceholder(upiPayeeVpa)) {
    throw new ConfigurationError("UPI_PAYEE_VPA must be a real receiving UPI ID in production");
  }

  return {
    nodeEnv,
    merchantDisplayName,
    gatewayPublicOrigin,
    upiPayeeVpa,
    databaseUrl: validDatabaseUrl(required(env, "DATABASE_URL"), production, allowPrivateDatabaseHost),
    merchantApiKey: validSecret(env, "MERCHANT_API_KEY", production),
    sessionSecret: validSecret(env, "SESSION_SECRET", production),
    orderTokenSecret: validSecret(env, "ORDER_TOKEN_SECRET", production),
  };
}

export function loadBootstrapConfig(env: Environment = process.env): BootstrapConfig {
  const email = required(env, "BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
  const password = required(env, "BOOTSTRAP_ADMIN_PASSWORD");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConfigurationError("BOOTSTRAP_ADMIN_EMAIL must be a valid email address");
  }
  const emailDomain = email.slice(email.lastIndexOf("@") + 1);
  if (
    isPlaceholder(email) ||
    [".test", ".example", ".invalid", ".localhost", ".local"].some((suffix) =>
      emailDomain.endsWith(suffix),
    ) ||
    ["example.com", "example.net", "example.org"].some(
      (domain) => emailDomain === domain || emailDomain.endsWith(`.${domain}`),
    )
  ) {
    throw new ConfigurationError(
      "BOOTSTRAP_ADMIN_EMAIL must be a real operator identity, not a template or example address",
    );
  }
  if (password.length < 16 || isPlaceholder(password)) {
    throw new ConfigurationError(
      "BOOTSTRAP_ADMIN_PASSWORD must be a unique password of at least 16 characters",
    );
  }
  return { email, password };
}

export function getPublicGatewayConfig(config: GatewayConfig) {
  return {
    gatewayOrigin: config.gatewayPublicOrigin,
    merchantDisplayName: config.merchantDisplayName,
    payeeVpa: config.upiPayeeVpa,
    currency: "INR" as const,
  };
}
