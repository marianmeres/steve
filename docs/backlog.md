# Backlog

Work after 4.0.0, ranked, not scheduled. This is the open copy: change it here.

The rows come from the plan that moved steve onto `@marianmeres/sqlkit` for 4.0.0, and
their ids continue that plan's. The plan was a local working set and is not part of the
repository, so a row that needs more than one line has its detail below the table.

**Status:** ⬜ open · ⏭️ deferred until its trigger · ✅ done

| Status | ID  | Rank | Task                                                                                                                                                           |
| ------ | --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⬜     | T10 | 1    | CI's PostgreSQL image from `postgres:17` to `postgres:18` in `.github/workflows/ci.yml`, the major of the local and production databases. A change of its own. |
| ⬜     | T11 | 2    | PGlite as a tested target. Adds a dev dependency. Ready once PGlite support is decided.                                                                        |
| ⏭️     | T12 | 3    | The schema through sqlkit's migrate wiring. Needs its own plan. Trigger: the first schema change `CREATE … IF NOT EXISTS` cannot express.                      |
| ⏭️     | T13 | 4    | A SQLite backend. Potentially planned (owner, 2026-11-19); needs its own plan.                                                                                 |
| ✅     | T14 | 5    | `pg` and `@types/pg` out of `dependencies`: done in 4.0.0, both are `devDependencies`.                                                                         |

## T11: PGlite as a tested target

PGlite speaks the `pg` dialect, so a host can pass a sqlkit `Driver` built on it through the
`db` option. A probe ran steve's schema, an insert and the claim on it. Two things are
missing before it can be called supported:

- a test in the suite: `start(2)`, one job through to `completed`;
- `healthPreview()`: its `count` reads as a number on PGlite and as a string on
  node-postgres.

## T12: the schema through migrations

steve's schema is one idempotent script run at first use. Versioned migrations need a
version table per table prefix (sqlkit's table names take letters, digits and underscores
only, and a prefix can be `"app."`), and a first version for deployed tables that is that
same idempotent script. No schema change is waiting for it.

## T13: a SQLite backend

It would come in through the `Driver` option, like PGlite, and be additive on top of
4.0.0: a minor release. 4.0.0 already did the dialect-neutral half. Statements are `sql`
fragments rendered per dialect (`?` placeholders included), lists bind through `inList()`
instead of array parameters, inserts go through `insert()` and `json()`, a busy database
is retried, the health check is `select 1`, several workers can share one connection
through sqlkit's single-connection driver, and `pg` is no longer a dependency.

Still to do:

- the schema per dialect: `SERIAL`, `JSONB`, `TIMESTAMPTZ`, `gen_random_uuid()`, the
  `DO $$` self-heal and the advisory lock are all Postgres;
- time: `NOW()`, the interval arithmetic and `EXTRACT(EPOCH …)`;
- the claim's `FOR UPDATE SKIP LOCKED`, which SQLite neither has nor needs;
- rows: SQLite stores JSON and instants as text, so a job row has to be decoded;
- `PRAGMA foreign_keys`, which sqlkit's `openSqlite` does not set and the purge's cascade
  depends on;
- the suite, which sets its cases up with Postgres SQL on a raw pool, has to run per
  driver;
- accepting a driver whose dialect is not `pg`: today it is refused with a `TypeError`.

Two things were left undone on purpose. Time arithmetic stays on the database's clock:
moving it into JavaScript would make the Postgres reaper compare an app host's clock with
timestamps the database wrote. And there is no row-decoding hook: the SQLite work edits
every statement again for the time expressions, so a hook added earlier would save it
nothing.
