-- Bigfoot SQL/viz shorthand scratch
--
-- This tests the SQL-authored UI artifact path, including the newer custom
-- renderers:
--   - renderer = basic_chart
--   - renderer = filter_control
--   - renderer = kpi_gauge
--   - renderer = sparkline
--   - renderer = kpi_timeline
--   - renderer = filter_binding meta rows
--   - renderer = statement_layout meta row
--
-- Test path:
--   1. Run the whole block.
--   2. It should open as an arranged dashboard.
--   3. Click a state bar in "Sightings by State" or pick a state in the control.
--   4. KPI, timeline, heatmap, and raw rows should re-run filtered to that state.
--   5. Re-click the same selected state to clear.
--
-- Filterable UI artifact convention:
--   If a UI artifact statement starts with a CTE named rvbbit_filter_source,
--   explicit filter bindings targeting that statement are pushed into that CTE
--   before the statement builds embedded JSON artifact data.

WITH states AS (
  SELECT
    state,
    count(*)::int AS sightings
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
  GROUP BY state
  ORDER BY sightings DESC, state
  LIMIT 25
)
SELECT
  'ui'::text AS rvbbit_artifact,
  v.artifact_id,
  v.artifact_kind,
  v.renderer,
  v.title,
  v.spec,
  v.data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM (
  VALUES
    (
      'name-state-filter',
      'meta',
      'statement_name',
      'State Filter',
      jsonb_build_object('name', 'state_filter'),
      NULL::jsonb
    ),
    (
      'state-filter',
      'control',
      'filter_control',
      'State Filter',
      jsonb_build_object(
        'kind', 'dropdown',
        'field', 'state',
        'operator', 'in'
      ),
      (SELECT jsonb_agg(jsonb_build_object('state', state) ORDER BY state) FROM states)
    ),
    (
      'bind-state-filter-kpi',
      'meta',
      'filter_binding',
      'State Filter -> KPI',
      jsonb_build_object('target', 'kpi_overview', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-filter-timeline',
      'meta',
      'filter_binding',
      'State Filter -> Timeline',
      jsonb_build_object('target', 'timeline_cards', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-filter-heatmap',
      'meta',
      'filter_binding',
      'State Filter -> County Heatmap',
      jsonb_build_object('target', 'county_heatmap', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-filter-rows',
      'meta',
      'filter_binding',
      'State Filter -> Raw Rows',
      jsonb_build_object('target', '#6', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

WITH states AS (
  SELECT
    state,
    count(*)::int AS sightings
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
  GROUP BY state
  ORDER BY sightings DESC, state
  LIMIT 25
)
SELECT
  'ui'::text AS rvbbit_artifact,
  v.artifact_id,
  v.artifact_kind,
  v.renderer,
  v.title,
  v.spec,
  v.data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM (
  VALUES
    (
      'name-state-bars',
      'meta',
      'statement_name',
      'Sightings by State',
      jsonb_build_object('name', 'state_bars'),
      NULL::jsonb
    ),
    (
      'state-bars',
      'chart',
      'basic_chart',
      'Sightings by State',
      jsonb_build_object(
        'kind', 'bar',
        'x', 'state',
        'y', 'sightings',
        'x_type', 'nominal',
        'y_type', 'quantitative',
        'sort', '-y'
      ),
      (SELECT jsonb_agg(to_jsonb(states)) FROM states)
    ),
    (
      'bind-state-bars-kpi',
      'meta',
      'filter_binding',
      'State Bars -> KPI',
      jsonb_build_object('target', 'kpi_overview', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-bars-timeline',
      'meta',
      'filter_binding',
      'State Bars -> Timeline',
      jsonb_build_object('target', 'timeline_cards', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-bars-heatmap',
      'meta',
      'filter_binding',
      'State Bars -> County Heatmap',
      jsonb_build_object('target', 'county_heatmap', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-bars-rows',
      'meta',
      'filter_binding',
      'State Bars -> Raw Rows',
      jsonb_build_object('target', '#6', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

WITH rvbbit_filter_source AS (
  SELECT
    bfroid,
    state,
    county,
    observed
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
),
summary AS (
  SELECT
    count(*)::int AS sightings,
    count(DISTINCT county)::int AS counties,
    greatest(count(*)::int, 500) AS max_value,
    CASE
      WHEN count(*) >= 500 THEN 'healthy'
      WHEN count(*) >= 150 THEN 'warning'
      ELSE 'thin'
    END AS status
  FROM rvbbit_filter_source
)
SELECT
  'ui'::text AS rvbbit_artifact,
  v.artifact_id,
  v.artifact_kind,
  v.renderer,
  v.title,
  v.spec,
  v.data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM (
  VALUES
    (
      'name-kpi-overview',
      'meta',
      'statement_name',
      'KPI Overview',
      jsonb_build_object('name', 'kpi_overview'),
      NULL::jsonb
    ),
    (
      'sighting-volume-kpi',
      'metric',
      'kpi_gauge',
      'Sighting Volume',
      jsonb_build_object(
        'label', 'Sighting Volume',
        'value_field', 'sightings',
        'max_field', 'max_value',
        'target', 500,
        'status_field', 'status',
        'good_high', true
      ),
      (SELECT jsonb_agg(to_jsonb(summary)) FROM summary)
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

WITH rvbbit_filter_source AS (
  SELECT
    bfroid,
    state,
    county,
    observed,
    coalesce(nullif(regexp_replace(bfroid, '\D', '', 'g'), '')::int, 0) AS sighting_id
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
),
series AS (
  SELECT
    make_date(2000 + (sighting_id % 24), 1 + (sighting_id % 12), 1) AS bucket_date,
    count(*)::int AS sightings,
    CASE
      WHEN count(*) >= 25 THEN 'healthy'
      WHEN count(*) >= 10 THEN 'warning'
      ELSE 'thin'
    END AS status
  FROM rvbbit_filter_source
  GROUP BY bucket_date
  ORDER BY bucket_date
)
SELECT
  'ui'::text AS rvbbit_artifact,
  v.artifact_id,
  v.artifact_kind,
  v.renderer,
  v.title,
  v.spec,
  v.data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM (
  VALUES
    (
      'name-timeline-cards',
      'meta',
      'statement_name',
      'Timeline Cards',
      jsonb_build_object('name', 'timeline_cards'),
      NULL::jsonb
    ),
    (
      'sighting-kpi-timeline',
      'metric',
      'kpi_timeline',
      'Volume Timeline',
      jsonb_build_object(
        'label', 'Volume Timeline',
        'time_field', 'bucket_date',
        'value_field', 'sightings',
        'target', 25,
        'status_field', 'status',
        'good_high', true
      ),
      (SELECT jsonb_agg(to_jsonb(series) ORDER BY bucket_date) FROM series)
    ),
    (
      'sighting-sparkline',
      'chart',
      'sparkline',
      'Sparkline',
      jsonb_build_object(
        'label', 'Monthly Sightings',
        'time_field', 'bucket_date',
        'value_field', 'sightings'
      ),
      (SELECT jsonb_agg(to_jsonb(series) ORDER BY bucket_date) FROM series)
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

WITH rvbbit_filter_source AS (
  SELECT
    bfroid,
    state,
    county,
    observed
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
    AND nullif(trim(county), '') IS NOT NULL
),
counties AS (
  SELECT
    state,
    county,
    count(*)::int AS sightings
  FROM rvbbit_filter_source
  GROUP BY state, county
  ORDER BY sightings DESC, state, county
  LIMIT 80
)
SELECT
  'ui'::text AS rvbbit_artifact,
  v.artifact_id,
  v.artifact_kind,
  v.renderer,
  v.title,
  v.spec,
  v.data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM (
  VALUES
    (
      'name-county-heatmap',
      'meta',
      'statement_name',
      'County Heatmap',
      jsonb_build_object('name', 'county_heatmap'),
      NULL::jsonb
    ),
    (
      'county-heatmap',
      'chart',
      'basic_chart',
      'County Heatmap',
      jsonb_build_object(
        'kind', 'heatmap',
        'x', 'state',
        'y', 'county',
        'color', 'sightings',
        'x_type', 'nominal',
        'y_type', 'nominal'
      ),
      (SELECT jsonb_agg(to_jsonb(counties)) FROM counties)
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

SELECT
  bfroid,
  title,
  state,
  county,
  left(observed, 240) AS observed_excerpt
FROM public.bigfoot_sightings
WHERE nullif(trim(state), '') IS NOT NULL
ORDER BY state NULLS LAST, county NULLS LAST, bfroid
LIMIT 250;

SELECT
  'ui'::text AS rvbbit_artifact,
  v.artifact_id,
  v.artifact_kind,
  v.renderer,
  v.title,
  v.spec,
  NULL::jsonb AS data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM (
  VALUES
    (
      'layout-bigfoot-viz',
      'meta',
      'statement_layout',
      'Bigfoot Viz Layout',
      jsonb_build_object(
        'mode', 'arrange',
        'rows', jsonb_build_array(
          jsonb_build_object(
            'h', 0.8,
            'tiles', jsonb_build_array(
              jsonb_build_object('name', 'state_filter', 'w', 0.7),
              jsonb_build_object('name', 'state_bars', 'w', 2.3)
            )
          ),
          jsonb_build_object(
            'h', 1.2,
            'tiles', jsonb_build_array(
              jsonb_build_object('name', 'kpi_overview', 'w', 0.9),
              jsonb_build_object('name', 'timeline_cards', 'w', 2.1)
            )
          ),
          jsonb_build_object(
            'h', 1.6,
            'tiles', jsonb_build_array(
              jsonb_build_object('name', 'county_heatmap', 'w', 1.4),
              jsonb_build_object('name', '#6', 'w', 1.0)
            )
          )
        )
      )
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec);
