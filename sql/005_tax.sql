-- 005_tax.sql — modular entity profile + year-scoped rates + tax tracking.
-- The entity_type toggle switches strategies; NO rates are literals in code.

CREATE TABLE IF NOT EXISTS acct_entity_profile (
  tenant_id            text   NOT NULL DEFAULT 'ariel',
  tax_year             int    NOT NULL,
  entity_type          text   NOT NULL DEFAULT 'sole_prop'
                       CHECK (entity_type IN ('sole_prop','single_llc','multi_llc','s_corp','c_corp','organize_only')),
  filing_status        text   NOT NULL DEFAULT 'single' CHECK (filing_status IN ('single','mfj','mfs','hoh')),
  state                text   NOT NULL DEFAULT 'CA',
  home_office_sqft     int,
  home_total_sqft      int,
  reasonable_salary_cents bigint,
  PRIMARY KEY (tenant_id, tax_year)
);

-- Year-scoped rate parameters. kind ∈ se_tax | income_bracket | std_deduction | qbi | ca_llc_fee | corp_rate ...
CREATE TABLE IF NOT EXISTS acct_tax_rates (
  tax_year     int  NOT NULL,
  jurisdiction text NOT NULL,         -- 'federal' | 'CA'
  kind         text NOT NULL,
  param_json   jsonb NOT NULL,
  PRIMARY KEY (tax_year, jurisdiction, kind)
);

CREATE TABLE IF NOT EXISTS acct_mileage_log (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL DEFAULT 'ariel',
  trip_date    date NOT NULL,
  miles        numeric(8,1) NOT NULL,
  project_slug text,
  purpose      text,
  rate_used    numeric(6,3)
);

CREATE TABLE IF NOT EXISTS acct_contractors (
  id             serial PRIMARY KEY,
  tenant_id      text NOT NULL DEFAULT 'ariel',
  name           text NOT NULL,
  tin_on_file    boolean NOT NULL DEFAULT false,
  w9_on_file     boolean NOT NULL DEFAULT false,
  ytd_paid_cents bigint  NOT NULL DEFAULT 0,
  tax_year       int     NOT NULL,
  UNIQUE (tenant_id, name, tax_year)
);

CREATE TABLE IF NOT EXISTS acct_estimated_payments (
  id                 bigserial PRIMARY KEY,
  tenant_id          text NOT NULL DEFAULT 'ariel',
  tax_year           int  NOT NULL,
  quarter            int  NOT NULL CHECK (quarter BETWEEN 1 AND 4),
  jurisdiction       text NOT NULL,
  due_date           date,
  estimated_due_cents bigint NOT NULL DEFAULT 0,
  paid_amount_cents  bigint NOT NULL DEFAULT 0,
  paid_date          date,
  UNIQUE (tenant_id, tax_year, quarter, jurisdiction)
);
