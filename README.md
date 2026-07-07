# rvbbit-lens

A focused, local-first **SQL Desktop** for Postgres. Connect to a database, browse
schemas, run queries in windowed tabs, drag column aggregates into the canvas,
chart results, and save SQL statements as desktop apps with custom icons.

When the database has the [`rvbbit`](../rvbbit-sql) extension installed, the desktop
opportunistically surfaces its semantic SQL surface: `rvbbit.knn_text`,
`rvbbit.topics`, the embedding cache, judgment receipts, etc.

## Status

Active development. Forked from the `rabbit-next` SQL Desktop interface and
stripped down — no auth, no multi-tenancy, no cloud control plane. Talks to
your local Postgres directly.

## Goals

- A great Postgres client first; semantic features second.
- Local-first: connection settings in `~/.config/rvbbit-lens/`, query history
  and saved apps in a per-database `rvbbit_lens` schema (opt-in).
- Postgres-native auth: bring your own role + password, no application user
  table.
- Zero cloud dependencies.

## Run

```bash
npm install
npm run dev
# http://localhost:3000
```

## Docker

```bash
docker build -t ghcr.io/ryrobes/rvbbit-lens:local .
docker run --rm -p 3000:3000 \
  -v rvbbit_lens:/data \
  -e RVBBIT_LENS_HOME=/data \
  ghcr.io/ryrobes/rvbbit-lens:local
```

For the all-in Rvbbit stack (this UI + Postgres 18 + the rvbbit extension +
the warren capability agent):

```bash
curl -fsSL https://rvbbit.ai/install.sh | bash
```

Docs: [rvbbit.ai/docs/data-rabbit](https://rvbbit.ai/docs/data-rabbit)

## Layout

```
src/
  app/
    page.tsx              # Desktop shell mounts here at /
    api/db/               # Postgres query/schema/extensions endpoints
  components/
    desktop/              # Window manager + all desktop apps
    ui/                   # shadcn-style primitives
  lib/
    db/                   # Connection registry, pg pool, schema crawler
    desktop/              # State store, drag types, sql-builder, artifacts
```
