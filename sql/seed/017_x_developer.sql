-- 017_x_developer.sql — X (Twitter) Developer Platform / API = business tooling.
-- The bank shows merchant "Developer" but the memo carries "X DEVELOPER PLATFORM
-- DEVELOPER.X.CTX" / "X DEVELOPER DES:Privacycom", so match on the MEMO field.

INSERT INTO acct_categorization_rules
  (priority, match_field, match_regex, account_code, project_slug, business_pct, needs_split, confidence, note)
VALUES
  (15,'memo','(?i)x ?developer|developer\.x|developer platform', '6150','shared',100,false,0.93,'seed:x-developer-api')
ON CONFLICT DO NOTHING;
