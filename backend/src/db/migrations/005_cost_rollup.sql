-- 005_cost_rollup.sql
-- Daily cost rollup materialized view, refreshed by the budget guard every
-- ~60s. A unique index on (day, model) is mandatory for
-- `REFRESH MATERIALIZED VIEW CONCURRENTLY`.

CREATE MATERIALIZED VIEW cost_daily_rollup AS
SELECT
  date_trunc('day', created_at)::date AS day,
  model,
  COALESCE(SUM(input_tokens), 0)::bigint        AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::bigint       AS output_tokens,
  COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input_tokens,
  COALESCE(SUM(cost_usd), 0)::numeric(14, 6)    AS cost_usd
FROM usage_records
GROUP BY 1, 2
WITH NO DATA;

CREATE UNIQUE INDEX idx_cost_daily_rollup_day_model
  ON cost_daily_rollup (day, model);

-- Populate so the view is queryable immediately after deploy.
REFRESH MATERIALIZED VIEW cost_daily_rollup;
