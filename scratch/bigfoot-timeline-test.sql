-- Bigfoot SQL/viz shorthand scratch
--
-- This is intentionally not just datasets. It exercises the SQL-authored UI
-- artifact path:
--   - renderer = vega_lite charts
--   - renderer = filter_control
--   - renderer = filter_binding meta rows
--   - renderer = statement_layout meta row
--
-- Test path:
--   1. Run the whole block.
--   2. It should open as an arranged dashboard.
--   3. Click a state bar in "Sightings by State" or pick a state in the control.
--   4. County/detail tiles should re-run with a state filter.
--   5. Re-click the same selected state to clear.
--
-- Note: the Report Themes tile is also SQL-authored Vega, but it is static in
-- this scratch. Cross-filter rewrite can target normal SQL statements because
-- they expose a `state` output column; it cannot rewrite inside a JSON data
-- payload already embedded in another UI artifact row.

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
      'bind-state-filter-counties',
      'meta',
      'filter_binding',
      'State Filter -> County Detail',
      jsonb_build_object('target', '#3', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-filter-rows',
      'meta',
      'filter_binding',
      'State Filter -> Raw Rows',
      jsonb_build_object('target', '#5', 'field', 'state', 'operator', 'in'),
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
      'vega_lite',
      'Sightings by State',
      jsonb_build_object(
        '$schema', 'https://vega.github.io/schema/vega-lite/v6.json',
        'mark', jsonb_build_object('type', 'bar', 'cornerRadiusEnd', 2),
        'encoding', jsonb_build_object(
          'x', jsonb_build_object('field', 'state', 'type', 'nominal', 'sort', '-y', 'axis', jsonb_build_object('labelAngle', -35)),
          'y', jsonb_build_object('field', 'sightings', 'type', 'quantitative'),
          'tooltip', jsonb_build_array(
            jsonb_build_object('field', 'state', 'type', 'nominal'),
            jsonb_build_object('field', 'sightings', 'type', 'quantitative')
          )
        )
      ),
      (SELECT jsonb_agg(to_jsonb(states)) FROM states)
    ),
    (
      'bind-state-bars-counties',
      'meta',
      'filter_binding',
      'State Bars -> County Detail',
      jsonb_build_object('target', '#3', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    ),
    (
      'bind-state-bars-rows',
      'meta',
      'filter_binding',
      'State Bars -> Raw Rows',
      jsonb_build_object('target', '#5', 'field', 'state', 'operator', 'in'),
      NULL::jsonb
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

SELECT
  state,
  county,
  count(*)::int AS sightings
FROM public.bigfoot_sightings
WHERE nullif(trim(state), '') IS NOT NULL
  AND nullif(trim(county), '') IS NOT NULL
GROUP BY state, county
ORDER BY sightings DESC, state, county
LIMIT 75;

WITH themed AS (
  SELECT
    state,
    CASE
      WHEN observed ILIKE '%road%' OR observed ILIKE '%highway%' THEN 'road / highway'
      WHEN observed ILIKE '%night%' OR observed ILIKE '%dark%' THEN 'night / dark'
      WHEN observed ILIKE '%camp%' OR observed ILIKE '%tent%' THEN 'camping'
      WHEN observed ILIKE '%tree%' OR observed ILIKE '%woods%' OR observed ILIKE '%forest%' THEN 'woods / forest'
      ELSE 'other'
    END AS report_theme,
    count(*)::int AS sightings
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
  GROUP BY state, report_theme
  ORDER BY sightings DESC, state, report_theme
  LIMIT 100
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
      'name-report-themes',
      'meta',
      'statement_name',
      'Report Themes',
      jsonb_build_object('name', 'report_themes'),
      NULL::jsonb
    ),
    (
      'report-themes',
      'chart',
      'vega_lite',
      'Report Themes',
      jsonb_build_object(
        '$schema', 'https://vega.github.io/schema/vega-lite/v6.json',
        'mark', jsonb_build_object('type', 'bar'),
        'encoding', jsonb_build_object(
          'x', jsonb_build_object('field', 'report_theme', 'type', 'nominal', 'sort', '-y'),
          'y', jsonb_build_object('field', 'sightings', 'type', 'quantitative'),
          'color', jsonb_build_object('field', 'report_theme', 'type', 'nominal', 'legend', NULL),
          'tooltip', jsonb_build_array(
            jsonb_build_object('field', 'state', 'type', 'nominal'),
            jsonb_build_object('field', 'report_theme', 'type', 'nominal'),
            jsonb_build_object('field', 'sightings', 'type', 'quantitative')
          )
        )
      ),
      (SELECT jsonb_agg(to_jsonb(themed)) FROM themed)
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec, data);

SELECT
  bfroid,
  title,
  state,
  county,
  observed
FROM public.bigfoot_sightings
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
            'h', 1,
            'tiles', jsonb_build_array(
              jsonb_build_object('name', 'state_filter', 'w', 0.7),
              jsonb_build_object('name', 'state_bars', 'w', 2.3)
            )
          ),
          jsonb_build_object(
            'h', 1.25,
            'tiles', jsonb_build_array(
              jsonb_build_object('name', '#3', 'w', 1.4),
              jsonb_build_object('name', 'report_themes', 'w', 1.0)
            )
          ),
          jsonb_build_object(
            'h', 1.6,
            'tiles', jsonb_build_array(
              jsonb_build_object('name', '#5', 'w', 1.0)
            )
          )
        )
      )
    )
) AS v(artifact_id, artifact_kind, renderer, title, spec);
