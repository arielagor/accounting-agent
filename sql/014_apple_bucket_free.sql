-- 014_apple_bucket_free.sql — allow a 'free' bucket on the Apple catalog so $0 app
-- downloads (not real expenses) stop cluttering the 'review' list. Drops the inline
-- auto-named CHECK and re-adds a named one that includes 'free'. Idempotent-ish.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
  WHERE conrelid = 'acct_apple_purchases'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%bucket%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE acct_apple_purchases DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE acct_apple_purchases
  ADD CONSTRAINT acct_apple_bucket_chk CHECK (bucket IN ('business','personal','review','free'));
