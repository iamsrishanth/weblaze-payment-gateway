CREATE TABLE admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admins_single_operator_guard ON admins ((true));

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  public_key_jwk jsonb NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  CONSTRAINT devices_scopes_valid CHECK (granted_scopes <@ ARRAY['observations', 'links:create', 'links:read_own']::text[])
);

CREATE TABLE receiver_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
  payee_vpa text NOT NULL,
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receiver_account_verification_pair CHECK ((verified_at IS NULL) = (verified_by IS NULL))
);
CREATE UNIQUE INDEX receiver_accounts_payee_vpa_unique ON receiver_accounts (lower(payee_vpa));

CREATE TABLE receiver_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiver_account_id uuid NOT NULL REFERENCES receiver_accounts(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('phonepe', 'bank_sms')),
  source_template_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receiver_profile_sms_template_required CHECK (source <> 'bank_sms' OR (source_template_id IS NOT NULL AND char_length(source_template_id) BETWEEN 1 AND 100))
);
CREATE UNIQUE INDEX receiver_profiles_unique_context ON receiver_profiles (device_id, source, COALESCE(source_template_id, ''));

CREATE TABLE pairing_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  granted_scopes text[] NOT NULL,
  created_by text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pairing_credentials_scopes_valid CHECK (granted_scopes <@ ARRAY['observations', 'links:create', 'links:read_own']::text[])
);

CREATE TABLE pair_request_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_ref text NOT NULL UNIQUE,
  amount_paise integer NOT NULL CHECK (amount_paise BETWEEN 1 AND 10000000),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  description text CHECK (description IS NULL OR char_length(description) <= 240),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notification_confirmed', 'needs_review', 'expired')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  merchant_display_name_snapshot text NOT NULL CHECK (char_length(merchant_display_name_snapshot) BETWEEN 1 AND 80),
  payee_vpa_snapshot text NOT NULL,
  receiver_account_id uuid REFERENCES receiver_accounts(id) ON DELETE RESTRICT,
  public_token_hash char(64) NOT NULL UNIQUE,
  public_token_ciphertext text NOT NULL,
  created_by_device_id uuid REFERENCES devices(id) ON DELETE RESTRICT,
  payment_source text CHECK (payment_source IS NULL OR payment_source IN ('phonepe', 'bank_sms')),
  bank_reconciliation_status text NOT NULL DEFAULT 'unreconciled' CHECK (bank_reconciliation_status IN ('unreconciled', 'reconciled')),
  reconciled_at timestamptz,
  reconciled_by text,
  official_bank_reference text,
  CONSTRAINT orders_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT orders_reconciliation_pair CHECK (
    (bank_reconciliation_status = 'unreconciled' AND reconciled_at IS NULL AND reconciled_by IS NULL AND official_bank_reference IS NULL)
    OR
    (bank_reconciliation_status = 'reconciled' AND reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL AND official_bank_reference IS NOT NULL)
  )
);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX orders_expiry_idx ON orders (expires_at) WHERE status = 'pending';
CREATE INDEX orders_device_created_idx ON orders (created_by_device_id, created_at DESC) WHERE created_by_device_id IS NOT NULL;

CREATE TABLE idempotency_records (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint char(64) NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE device_request_nonces (
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX device_request_nonces_expiry_idx ON device_request_nonces (expires_at);
CREATE INDEX pair_request_nonces_expiry_idx ON pair_request_nonces (expires_at);

CREATE TABLE observation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  event_id text NOT NULL,
  body_hash char(64) NOT NULL,
  schema_version smallint NOT NULL CHECK (schema_version = 1),
  source text NOT NULL CHECK (source IN ('phonepe', 'bank_sms')),
  event_kind text NOT NULL CHECK (event_kind IN ('incoming_credit', 'reversal')),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise BETWEEN 1 AND 10000000),
  currency text NOT NULL CHECK (currency = 'INR'),
  merchant_ref text,
  bank_ref text,
  observed_payee_vpa text,
  receiver_profile_id uuid REFERENCES receiver_profiles(id) ON DELETE RESTRICT,
  source_transaction_id text,
  source_template_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, event_id)
);
CREATE INDEX observation_events_bank_ref_idx ON observation_events (bank_ref) WHERE bank_ref IS NOT NULL;
CREATE INDEX observation_events_merchant_ref_idx ON observation_events (merchant_ref) WHERE merchant_ref IS NOT NULL;
CREATE INDEX observation_events_created_idx ON observation_events (created_at DESC);

-- A bank credit is the underlying receiver-side credit identity. Observed events are evidence only.
CREATE TABLE bank_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiver_account_id uuid NOT NULL REFERENCES receiver_accounts(id) ON DELETE RESTRICT,
  bank_ref text NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise BETWEEN 1 AND 10000000),
  first_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (receiver_account_id, bank_ref)
);

-- Review cases group cross-source evidence when a verified account + bank reference exist.
-- Reference-free observations get a distinct case and can never auto-match.
CREATE TABLE credit_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiver_account_id uuid REFERENCES receiver_accounts(id) ON DELETE RESTRICT,
  bank_credit_id uuid UNIQUE REFERENCES bank_credits(id) ON DELETE RESTRICT,
  first_event_id uuid NOT NULL UNIQUE REFERENCES observation_events(id) ON DELETE RESTRICT,
  amount_paise integer NOT NULL CHECK (amount_paise BETWEEN 1 AND 10000000),
  merchant_ref text,
  bank_ref text,
  observed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('phonepe', 'bank_sms')),
  event_kind text NOT NULL CHECK (event_kind IN ('incoming_credit', 'reversal')),
  is_conflicted boolean NOT NULL DEFAULT false,
  review_status text NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'resolved')),
  review_reason text NOT NULL,
  candidate_order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  resolved_order_id uuid REFERENCES orders(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_cases_review_idx ON credit_cases (created_at DESC) WHERE review_status = 'open';

CREATE TABLE credit_case_events (
  credit_case_id uuid NOT NULL REFERENCES credit_cases(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL UNIQUE REFERENCES observation_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (credit_case_id, event_id)
);

-- Enforces one underlying credit per order and one order per underlying credit.
CREATE TABLE credit_matches (
  bank_credit_id uuid PRIMARY KEY REFERENCES bank_credits(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  matched_at timestamptz NOT NULL,
  matched_by text NOT NULL,
  match_type text NOT NULL CHECK (match_type IN ('automatic', 'manual')),
  source text NOT NULL CHECK (source IN ('phonepe', 'bank_sms'))
);

CREATE TABLE bank_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  actor_id text NOT NULL,
  official_bank_reference text NOT NULL,
  reason text NOT NULL,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bank_reconciliations_order_idx ON bank_reconciliations (order_id, checked_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_target_idx ON audit_events (target_type, target_id, created_at DESC);

CREATE TABLE rate_limit_buckets (
  key_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 1),
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limit_buckets_expiry_idx ON rate_limit_buckets (expires_at);
