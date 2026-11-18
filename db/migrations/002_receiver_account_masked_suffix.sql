ALTER TABLE receiver_accounts
  ADD COLUMN masked_account_suffix text;

ALTER TABLE receiver_accounts
  ADD CONSTRAINT receiver_accounts_masked_account_suffix_check
  CHECK (
    masked_account_suffix IS NULL
    OR (char_length(masked_account_suffix) = 4 AND masked_account_suffix ~ '^[0-9]{4}$')
  );
