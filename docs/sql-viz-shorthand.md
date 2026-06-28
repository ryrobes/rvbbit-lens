# SQL Viz Shorthand Primitives

SQL-authored UI artifacts let a result statement return small dashboard surfaces
without requiring a separate saved dashboard definition. The target use case is
operational inspection: compact charts, KPI cards, filters, and drill-down tables
that can be authored in the same SQL block as the data they summarize.

The code-level renderer contract lives in
`src/lib/desktop/ui-artifact-contract.ts`.

## Artifact Row Shape

A UI artifact statement returns only rows with `rvbbit_artifact = 'ui'`.
The viewer treats those rows as renderer declarations:

```sql
SELECT
  'ui'::text AS rvbbit_artifact,
  'state-bars'::text AS artifact_id,
  'chart'::text AS artifact_kind,
  'basic_chart'::text AS renderer,
  'Sightings by State'::text AS title,
  jsonb_build_object('kind', 'bar', 'x', 'state', 'y', 'sightings') AS spec,
  jsonb_agg(jsonb_build_object('state', state, 'sightings', sightings)) AS data,
  NULL::jsonb AS layout,
  NULL::jsonb AS bindings,
  NULL::jsonb AS diagnostics
FROM states;
```

`spec` is the renderer configuration. `data` should be a JSON array of record
objects for renderers that need rows. `layout`, `bindings`, and `diagnostics` are
reserved extension points; current metadata is carried through `spec`.

## Visible Renderers

`basic_chart` is the short path for common analytical marks. Use `kind` or
`mark` with `bar`, `line`, `area`, `point`, `scatter`, `histogram`, `heatmap`,
or `rect`. Common fields are `x`, `y`, `color`, `size`, `x_type`, `y_type`,
`aggregate`, `sort`, `bin`, and `point`. The renderer compiles this shorthand to
Vega-Lite and injects `data` as inline values.

`vega_lite` is the escape hatch for full Vega-Lite specs. If the Vega-Lite spec
does not define its own `data`, artifact `data` is injected as `{ values: data }`.
Click filtering is based on the `encoding.x.field` value.

`metric_card` displays a scalar value from `spec.value`, with optional
`spec.label`.

`kpi_gauge` displays a KPI value plus a gauge. It accepts direct values or first
row fields: `value` or `value_field`, `max` or `max_field`, `target` or
`target_field`, `status_field`, `unit`, and `good_high` or `higher_is_better`.

`sparkline` displays a compact trend. Use `value_field`, optional `label`, `unit`,
`color`, `y_min`, and `y_max`.

`kpi_timeline` is the compound operational primitive: latest KPI value, delta,
gauge, status badge, and sparkline in one tile. Use `time_field`, `value_field`,
`target`, `max`, `status_field`, `unit`, `good_high`, `y_min`, and `y_max`.

`table_view` renders artifact `data` as a compact table. Optional
`spec.columns` controls column order.

`filter_control` emits a filter parameter from UI state. Supported `kind` values
are `dropdown`, `multiselect`, `datepicker`, and `slider`. Use `field` and
optional `operator` (`eq`, `in`, `gte`, or `lte`). Filter controls do not choose
targets by themselves; wire targets with `filter_binding` metadata rows.

`action_button` runs SQL from `spec.sql`. Optional keys are `label`, `variant`,
`confirm`, and `refresh`.

## Metadata Renderers

Metadata rows use `artifact_kind = 'meta'`; they are consumed by the result
transcript and are not rendered as visible cards.

`statement_name` gives a result statement a stable alias:

```sql
SELECT
  'ui' AS rvbbit_artifact,
  'name-kpi' AS artifact_id,
  'meta' AS artifact_kind,
  'statement_name' AS renderer,
  'KPI Overview' AS title,
  jsonb_build_object('name', 'kpi_overview') AS spec,
  NULL::jsonb AS data;
```

`filter_binding` connects a filter-emitting statement to a target statement:

```sql
SELECT
  'ui' AS rvbbit_artifact,
  'bind-state-filter-kpi' AS artifact_id,
  'meta' AS artifact_kind,
  'filter_binding' AS renderer,
  'State Filter -> KPI' AS title,
  jsonb_build_object(
    'target', 'kpi_overview',
    'field', 'state',
    'operator', 'in'
  ) AS spec,
  NULL::jsonb AS data;
```

`target` can be a `statement_name`, a visible artifact title, a raw result index
like `#6`, or the equivalent one-based number as text.

`statement_layout` arranges multi-statement results. The current layout mode is
`arrange`, with rows containing weighted tiles:

```sql
jsonb_build_object(
  'mode', 'arrange',
  'rows', jsonb_build_array(
    jsonb_build_object(
      'h', 1.2,
      'tiles', jsonb_build_array(
        jsonb_build_object('name', 'kpi_overview', 'w', 0.9),
        jsonb_build_object('name', 'timeline_cards', 'w', 2.1)
      )
    )
  )
)
```

## Filterable Artifact Statements

Artifact statements usually output only UI columns, so the generic SQL filter
wrapper cannot see domain fields like `state`. To make an artifact statement
filterable, start it with a CTE named `rvbbit_filter_source`:

```sql
WITH rvbbit_filter_source AS (
  SELECT state, county, observed
  FROM public.bigfoot_sightings
  WHERE nullif(trim(state), '') IS NOT NULL
),
summary AS (
  SELECT state, count(*)::int AS sightings
  FROM rvbbit_filter_source
  GROUP BY state
)
SELECT ...;
```

When a `filter_binding` explicitly targets this statement, the desktop runtime
pushes the filter into `rvbbit_filter_source` before the artifact builds JSON.
This keeps KPI, timeline, heatmap, and other pre-aggregated cards honest.

Plain table statements do not need the CTE convention. If a binding targets a
single base-table `SELECT`, the runtime wraps the base table before `WHERE`,
`GROUP BY`, `ORDER BY`, and `LIMIT`, so a raw drill-down table filters in the
same click cycle as the charts.

## Design Guidance

Use custom primitives for repeated operational shapes with few meaningful
options: KPI gauges, sparklines, compact timelines, filter controls, and action
buttons. They stay visually consistent and avoid asking SQL authors to remember
Vega-Lite details for common dashboard controls.

Use `basic_chart` for ordinary exploratory charts where the data shape is simple
and the mark choice is enough.

Use full `vega_lite` when the chart needs faceting, layered marks, transforms,
custom encodings, or chart-specific polish that should not become a permanent
desktop primitive.

The scratch block at `scratch/bigfoot-timeline-test.sql` is the current reference
fixture for this contract.
