-- 011_projects.sql — the portfolio + a 'shared' bucket for cost allocation. Idempotent.

INSERT INTO acct_projects (slug, name, status, is_shared) VALUES
  ('agor_me','agor.me (consulting + voice)','active',false),
  ('agor_agents','Agor Agents (app.agor.me)','active',false),
  ('agor_supervisor','Agor Supervisor (app.mvat.ai)','active',false),
  ('ai_visibility','AI Visibility Audit','active',false),
  ('mvat_focus','MVAT Focus','active',false),
  ('modelstack','modelstack.digital','active',false),
  ('scored_tools','scored.tools','active',false),
  ('gifloop','GifLoop','active',false),
  ('aphor_me','aphor.me','parked',false),
  ('shared','Shared infrastructure','active',true),
  ('personal','Personal (non-business)','active',false)
ON CONFLICT (slug) DO NOTHING;
