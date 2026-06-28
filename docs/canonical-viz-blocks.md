# Canonical Viz Blocks

Canonical viz blocks are versioned SQL templates that emit the SQL/viz shorthand
artifact rows rendered by Lens. They sit above known data objects: tables,
columns, metrics, KPIs, cubes, queries, and dashboards.

The goal is composable curated context. An agent or user should be able to ask
for an object like `public.orders` or `daily_revenue`, look up the blocks that
apply to it, instantiate a few templates, and get a useful SQL-authored dashboard
without starting from a blank canvas.

## Backend Shape

`rvbbit.viz_block_defs` is append-versioned. Calling `rvbbit.define_viz_block`
with an existing name creates a new version.

`rvbbit.viz_block_catalog` is the latest-version view.

`rvbbit.viz_object_links` links a block to known objects:

```sql
SELECT rvbbit.link_viz_block(
  p_block_name  => 'table_overview',
  p_object_kind => 'table',
  p_object_key  => 'public.bigfoot_sightings',
  p_role        => 'source',
  p_confidence  => 1.0,
  p_link_source => 'declared'
);
```

Links can target the latest block version or a pinned version. Most canonical
links should target latest so block polish carries forward without relinking.

## Defining A Block

Templates use the same token convention as metrics:

`{name}` becomes a quoted SQL literal.

`{name!}` becomes raw SQL text for identifiers, qualified table names, or
prevalidated clauses.

```sql
SELECT rvbbit.define_viz_block(
  p_name         => 'table_state_distribution',
  p_title        => 'State Distribution',
  p_intent       => 'distribution',
  p_description  => 'Filterable bar chart and drilldown for a state-like column.',
  p_sql_template => $sql$
WITH states AS (
  SELECT {dimension!} AS state, count(*)::int AS sightings
  FROM {table!}
  WHERE {dimension!} IS NOT NULL
  GROUP BY 1
  ORDER BY sightings DESC
  LIMIT 25
)
SELECT
  'ui'::text AS rvbbit_artifact,
  'state-bars' AS artifact_id,
  'chart' AS artifact_kind,
  'basic_chart' AS renderer,
  'Sightings by State' AS title,
  jsonb_build_object('kind', 'bar', 'x', 'state', 'y', 'sightings') AS spec,
  (SELECT jsonb_agg(to_jsonb(states)) FROM states) AS data;
$sql$,
  p_input_schema => jsonb_build_object(
    'required', jsonb_build_array('table', 'dimension'),
    'roles', jsonb_build_object(
      'table', 'qualified relation name',
      'dimension', 'column expression'
    )
  ),
  p_params => jsonb_build_object(
    'table', 'public.bigfoot_sightings',
    'dimension', 'state'
  ),
  p_links => jsonb_build_array(jsonb_build_object(
    'object_kind', 'table',
    'object_key', 'public.bigfoot_sightings',
    'role', 'source',
    'confidence', 1.0,
    'link_source', 'declared'
  ))
);
```

Preview the instantiated SQL:

```sql
SELECT rvbbit.preview_viz_block_sql(
  $sql$SELECT * FROM {table!} LIMIT {limit!}$sql$,
  jsonb_build_object('table', 'public.bigfoot_sightings', 'limit', 25)
);

SELECT rvbbit.preview_viz_block(
  'table_state_distribution',
  jsonb_build_object('table', 'public.bigfoot_sightings', 'dimension', 'state')
);
```

Find blocks for an object:

```sql
SELECT *
FROM rvbbit.viz_blocks_for_object('table', 'public.bigfoot_sightings', NULL);
```

## View Leverage

Because a block instantiates to valid SQL, tooling can turn a fully bound block
into a real Postgres view:

```sql
CREATE VIEW viz.bigfoot_state_distribution AS
SELECT *
FROM (
  -- output of rvbbit.preview_viz_block(...)
) q;
```

The view is still UI-specific because it emits `rvbbit_artifact = 'ui'` rows, but
it becomes discoverable, permissionable, and inspectable like any other SQL
object.

## Lens UI

The dedicated UI is an editor over this backend, not a separate registry. Open
`Viz Blocks` from the Metrics folder.

The first screen has:

- left rail: blocks grouped by intent
- center: SQL template editor plus input schema/params editor
- live resolved-SQL preview with a Run action into the existing SQL artifact path

Core actions:

- create block
- save new version
- preview instantiated SQL
- run preview
- link/unlink known objects
- show versions and restore-by-saving a prior version

Agent flow:

- resolve candidate objects from catalog/KG/metric/cube search
- call `viz_blocks_for_object`
- instantiate top blocks with object-specific params
- compose the generated SQL statements and `statement_layout` metadata
- present the result as editable SQL
