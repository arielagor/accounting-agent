-- 016_ai_tech_vendors.sql — comprehensive AI + tech vendor categorization rules.
-- "Categorize all business spending, especially AI and tech" (Ariel, 2026-06-13).
-- These auto-post as business deductions with high confidence, no LLM needed.
-- priority 15 = ahead of the generic needs_split rules (50-60). business_pct 100,
-- project 'shared' (cross-product tools; the allocation engine splits shared costs).

INSERT INTO acct_categorization_rules
  (priority, match_field, match_regex, account_code, project_slug, business_pct, needs_split, confidence, note)
VALUES
  -- ── AI model / API / tooling (6150 Software & SaaS) ──
  (15,'merchant','(?i)grok\.com|grok\.ai|\bx\.?ai\b',        '6150','shared',100,false,0.96,'seed:ai-grok-xai'),
  (15,'merchant','(?i)openai|chatgpt',                       '6150','shared',100,false,0.97,'seed:ai-openai'),
  (15,'merchant','(?i)perplexity',                           '6150','shared',100,false,0.96,'seed:ai-perplexity'),
  (15,'merchant','(?i)midjourney|ideogram|leonardo\.?ai|stability\.?ai|runway|pika\.?art|suno|kling', '6150','shared',100,false,0.95,'seed:ai-image-video'),
  (15,'merchant','(?i)eleven\s?labs|elevenlabs|heygen|descript|deepgram|assembly\s?ai|otter\.ai|fathom|fireflies', '6150','shared',100,false,0.95,'seed:ai-audio-video'),
  (15,'merchant','(?i)replicate|hugging\s?face|huggingface|cohere|mistral|together\.?ai|fireworks\.?ai|\bgroq\b|fal\.ai', '6150','shared',100,false,0.95,'seed:ai-inference'),
  (15,'merchant','(?i)pinecone|weaviate|langchain|langsmith|llama\s?index|llamaindex|weights\s*&?\s*biases|\bwandb\b', '6150','shared',100,false,0.95,'seed:ai-infra'),
  (15,'merchant','(?i)cursor|codeium|windsurf|tabnine|copilot|replit|v0\.dev|bolt\.new|lovable\.dev', '6150','shared',100,false,0.95,'seed:ai-coding'),
  (15,'merchant','(?i)gamma\.app|grammarly|google\s?one|google\s?ai|notebooklm', '6150','shared',100,false,0.90,'seed:ai-productivity'),
  -- ── Dev / SaaS tooling (6150) ──
  (15,'merchant','(?i)\bnotion\b|\blinear\b|figma|framer|airtable|retool|postman|jetbrains|sentry|datadog|posthog|mixpanel|amplitude|segment', '6150','shared',100,false,0.93,'seed:dev-saas'),
  (15,'merchant','(?i)zapier|make\.com|\bn8n\b|1password|dashlane|superhuman|raycast|loom|calendly|cal\.com|zoom|slack', '6150','shared',100,false,0.92,'seed:productivity-saas'),
  (15,'merchant','(?i)gumroad|beehiiv|convertkit|substack|mailchimp|sendgrid|postmark|\bresend\b|kit\.com', '6150','shared',100,false,0.92,'seed:creator-saas'),
  (15,'merchant','(?i)adobe|canva|capcut|jasper|copy\.ai|writesonic', '6150','shared',100,false,0.90,'seed:content-saas'),
  -- ── Hosting & cloud (6160) ──
  (14,'merchant','(?i)\baws\b|amazon\s?web\s?services|aws\.amazon',  '6160','shared',100,false,0.95,'seed:cloud-aws'),
  (14,'merchant','(?i)google\s?cloud|\bgcp\b|google\s?\*?cloud',     '6160','shared',100,false,0.95,'seed:cloud-gcp'),
  (14,'merchant','(?i)microsoft\s?azure|\bazure\b',                  '6160','shared',100,false,0.93,'seed:cloud-azure'),
  (14,'merchant','(?i)digital\s?ocean|digitalocean|\bvultr\b|linode|\bovh\b', '6160','shared',100,false,0.93,'seed:cloud-vps'),
  (14,'merchant','(?i)render\.com|fly\.io|railway\.app|heroku|planetscale|neon\.tech|upstash|supabase', '6160','shared',100,false,0.93,'seed:cloud-paas'),
  (14,'merchant','(?i)cloudflare|fastly|akamai',                     '6160','shared',100,false,0.90,'seed:cloud-cdn'),
  -- ── Advertising platforms (6010) — checked before cloud so "google ads" != "google cloud" ──
  (12,'merchant','(?i)google\s?ads|google\s?adwords|adwords',        '6010','shared',100,false,0.94,'seed:ads-google'),
  (12,'merchant','(?i)meta\s?ads|facebook\s?ads|\bfb\s?ads|instagram\s?ads', '6010','shared',100,false,0.94,'seed:ads-meta'),
  (12,'merchant','(?i)(twitter|\bx\b)\s?ads|linkedin\s?ads|tiktok\s?ads|reddit\s?ads|microsoft\s?advertising|bing\s?ads', '6010','shared',100,false,0.92,'seed:ads-other'),
  -- ── Domains & DNS (6170) ──
  (13,'merchant','(?i)porkbun|\bhover\b|gandi|name\.com|dnsimple|squarespace\s?domains', '6170','shared',100,false,0.92,'seed:domains-extra')
ON CONFLICT DO NOTHING;
