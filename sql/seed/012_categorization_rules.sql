-- 012_categorization_rules.sql — deterministic merchant→account rules. Idempotent by note tag.
-- These are high-confidence auto-post rules. Ambiguous vendors are marked needs_split.

INSERT INTO acct_categorization_rules
  (priority, match_field, match_regex, amount_min_cents, amount_max_cents, account_code, project_slug, business_pct, needs_split, confidence, note)
VALUES
  (10,'merchant','(?i)netlify',                  NULL, NULL, '6160','shared',      100, false, 0.98, 'seed:netlify-hosting-shared'),
  (10,'merchant','(?i)vercel',                   NULL, NULL, '6160','shared',      100, false, 0.98, 'seed:vercel-hosting-shared'),
  (10,'merchant','(?i)firebase|google\\s*cloud', NULL, NULL, '6160','shared',      100, false, 0.95, 'seed:firebase-hosting-shared'),
  (10,'merchant','(?i)anthropic|claude\\.ai',    NULL, NULL, '6150','shared',      100, false, 0.98, 'seed:anthropic-software-shared'),
  (10,'merchant','(?i)openai',                   NULL, NULL, '6150','shared',      100, false, 0.95, 'seed:openai-software-shared'),
  (10,'merchant','(?i)github',                   NULL, NULL, '6150','shared',      100, false, 0.95, 'seed:github-software-shared'),
  (10,'merchant','(?i)twilio',                   NULL, NULL, '6150','agor_me',     100, false, 0.90, 'seed:twilio-voice-agorme'),
  (10,'merchant','(?i)expo|eas\\b',              NULL, NULL, '6150','mvat_focus',  100, false, 0.90, 'seed:expo-mvatfocus'),
  (10,'merchant','(?i)namecheap|cloudflare|google\\s*domains|godaddy', NULL, NULL, '6170','shared', 100, false, 0.95, 'seed:domains-shared'),
  (10,'merchant','(?i)stripe',                   NULL, NULL, '5010','shared',      100, false, 0.85, 'seed:stripe-fees'),
  -- Apple Developer membership: $99/yr band → Taxes & Licenses, shared dev cost
  (20,'merchant','(?i)apple.*developer',         9800, 10200, '6110','shared',     100, false, 0.95, 'seed:apple-dev-membership'),
  -- Generic Apple billing → ambiguous (could be IAP fee, iCloud, hardware); needs split
  (50,'merchant','(?i)apple\\.com/bill|apple\\s*services', NULL, NULL, '9000', NULL, 100, true, 0.50, 'seed:apple-bill-needs-split'),
  (20,'merchant','(?i)google\\s*play',           NULL, NULL, '5020','shared',      100, false, 0.85, 'seed:google-play-iap-fee'),
  -- Mixed-use vendors → quarantine for split decision
  (60,'merchant','(?i)amazon|amzn',              NULL, NULL, '9000', NULL,         100, true, 0.45, 'seed:amazon-needs-split')
ON CONFLICT DO NOTHING;
