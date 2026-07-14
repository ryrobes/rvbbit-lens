import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import pg from "pg"

const { Client } = pg

const APP_PREFIX = "LX demo | "
const SCHEMA = "lock_explorer_demo"
const STATE_DIR = path.join(tmpdir(), "rvbbit-lens-lock-explorer-demo")
const PID_FILE = `${STATE_DIR}.pid`
const READY_FILE = `${STATE_DIR}.ready.json`
const LOG_FILE = `${STATE_DIR}.log`
const SCRIPT_FILE = fileURLToPath(import.meta.url)
const DEFAULT_MINUTES = 45
const EXPECTED_SESSIONS = 10
const MIN_EXPECTED_EDGES = 7

const connection = {
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 55433),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "rvbbit",
  database: process.env.PGDATABASE || "bench",
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function clientFor(applicationName) {
  const client = new Client({ ...connection, application_name: applicationName })
  client.on("error", (error) => {
    console.error(`${applicationName}: ${error.message}`)
  })
  return client
}

function livePid() {
  if (!existsSync(PID_FILE)) return null
  const pid = Number(readFileSync(PID_FILE, "utf8").trim())
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function cleanupRuntimeFiles(ownerPid = null) {
  if (ownerPid != null) {
    const recordedPid = existsSync(PID_FILE)
      ? Number(readFileSync(PID_FILE, "utf8").trim())
      : null
    if (recordedPid !== ownerPid) return
  }
  rmSync(PID_FILE, { force: true })
  rmSync(READY_FILE, { force: true })
}

async function statusSnapshot() {
  const client = clientFor("lock-explorer-demo-observer")
  await client.connect()
  try {
    const sessions = await client.query(
      `SELECT pid,
              application_name,
              state,
              wait_event_type,
              wait_event,
              extract(epoch FROM (clock_timestamp() - xact_start))::int AS transaction_age_s
       FROM pg_stat_activity
       WHERE application_name LIKE $1
       ORDER BY application_name`,
      [`${APP_PREFIX}%`],
    )
    const edges = await client.query(
      `WITH demo AS (
         SELECT pid, application_name
         FROM pg_stat_activity
         WHERE application_name LIKE $1
       )
       SELECT waiter.pid AS waiter_pid,
              waiter.application_name AS waiter,
              blocker.pid AS blocker_pid,
              blocker.application_name AS blocker
       FROM demo waiter
       CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocked_by(pid)
       LEFT JOIN demo blocker ON blocker.pid = blocked_by.pid
       ORDER BY waiter.application_name, blocker.application_name`,
      [`${APP_PREFIX}%`],
    )
    return { sessions: sessions.rows, edges: edges.rows }
  } finally {
    await client.end()
  }
}

async function terminateAndDrop() {
  const client = clientFor("lock-explorer-demo-cleanup")
  await client.connect()
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE application_name LIKE $1
         AND pid <> pg_backend_pid()`,
      [`${APP_PREFIX}%`],
    )
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  } finally {
    await client.end()
  }
}

async function waitFor(check, detail, timeoutMs = 12_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${detail}`)
}

async function waitForPendingLock(observer, pid, mode, lockType) {
  await waitFor(async () => {
    const result = await observer.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
         WHERE pid = $1 AND mode = $2 AND locktype = $3 AND NOT granted
       ) AS waiting`,
      [pid, mode, lockType],
    )
    return result.rows[0]?.waiting === true
  }, `${mode} ${lockType} request from pid ${pid}`)
}

async function runDemo(minutes) {
  const observer = clientFor("lock-explorer-demo-controller")
  const clients = []
  const pending = []
  let shuttingDown = false

  function make(name) {
    const client = clientFor(`${APP_PREFIX}${name}`)
    clients.push(client)
    return client
  }

  function block(client, sql, label) {
    pending.push(client.query(sql).catch((error) => {
      if (!shuttingDown) console.error(`${label}: ${error.message}`)
    }))
  }

  async function cleanup() {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await terminateAndDrop()
    } catch (error) {
      console.error(`cleanup: ${error.message}`)
    }
    await Promise.race([
      Promise.allSettled([...pending, ...clients.map((client) => client.end())]),
      delay(2_000),
    ])
    cleanupRuntimeFiles(process.pid)
  }

  try {
    await observer.connect()
    await observer.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`)
    await observer.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.queue_gate (
        id integer PRIMARY KEY,
        note text NOT NULL
      )
    `)
    await observer.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.row_gate (
        id integer PRIMARY KEY,
        note text NOT NULL
      )
    `)
    await observer.query(`
      INSERT INTO ${SCHEMA}.queue_gate (id, note) VALUES (1, 'table queue')
      ON CONFLICT (id) DO NOTHING
    `)
    await observer.query(`
      INSERT INTO ${SCHEMA}.row_gate (id, note) VALUES (1, 'row conflict')
      ON CONFLICT (id) DO NOTHING
    `)

    const advisoryRoot = make("adv root")
    const advisoryMiddle = make("adv middle")
    const advisoryLeaf = make("adv leaf")
    const advisoryFanA = make("adv fan A")
    const advisoryFanB = make("adv fan B")
    const tableHolder = make("table AS holder")
    const tableDdl = make("table AX waiter")
    const tableSoft = make("table soft AS")
    const rowHolder = make("row writer holder")
    const rowWaiter = make("row writer waiter")

    await Promise.all(clients.map((client) => client.connect()))

    await advisoryRoot.query("SELECT pg_advisory_lock(260714, 1)")
    await advisoryMiddle.query("SELECT pg_advisory_lock(260714, 2)")
    block(advisoryMiddle, "SELECT pg_advisory_lock(260714, 1)", "advisory middle")
    await waitForPendingLock(observer, advisoryMiddle.processID, "ExclusiveLock", "advisory")
    block(advisoryLeaf, "SELECT pg_advisory_lock(260714, 2)", "advisory leaf")
    block(advisoryFanA, "SELECT pg_advisory_lock(260714, 1)", "advisory fan A")
    block(advisoryFanB, "SELECT pg_advisory_lock(260714, 1)", "advisory fan B")

    await tableHolder.query("BEGIN")
    await tableHolder.query(`LOCK TABLE ${SCHEMA}.queue_gate IN ACCESS SHARE MODE`)
    await tableDdl.query("BEGIN")
    block(tableDdl, `LOCK TABLE ${SCHEMA}.queue_gate IN ACCESS EXCLUSIVE MODE`, "table AX waiter")
    await waitForPendingLock(observer, tableDdl.processID, "AccessExclusiveLock", "relation")
    await tableSoft.query("BEGIN")
    block(tableSoft, `LOCK TABLE ${SCHEMA}.queue_gate IN ACCESS SHARE MODE`, "table soft reader")

    await rowHolder.query("BEGIN")
    await rowHolder.query(`UPDATE ${SCHEMA}.row_gate SET note = note WHERE id = 1`)
    await rowWaiter.query("BEGIN")
    block(rowWaiter, `UPDATE ${SCHEMA}.row_gate SET note = note WHERE id = 1`, "row writer waiter")

    await waitFor(async () => {
      const snapshot = await statusSnapshot()
      return snapshot.sessions.length === EXPECTED_SESSIONS && snapshot.edges.length >= MIN_EXPECTED_EDGES
    }, `at least ${MIN_EXPECTED_EDGES} blocker edges`)

    const snapshot = await statusSnapshot()

    const ready = {
      pid: process.pid,
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      sessionCount: snapshot.sessions.length,
      edgeCount: snapshot.edges.length,
      sessionPids: clients.map((client) => client.processID),
    }
    writeFileSync(READY_FILE, JSON.stringify(ready, null, 2))
    console.log(`Lock Explorer demo ready: ${ready.sessionCount} sessions, ${ready.edgeCount} blocker edges`)
    console.log(`Expires at ${ready.expiresAt}`)

    await observer.end()

    let stop
    const stopped = new Promise((resolve) => { stop = resolve })
    const timer = setTimeout(() => stop("expired"), minutes * 60_000)
    process.once("SIGTERM", () => stop("stopped"))
    process.once("SIGINT", () => stop("stopped"))
    const reason = await stopped
    clearTimeout(timer)
    console.log(`Lock Explorer demo ${reason}; cleaning up`)
    await cleanup()
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error))
    try { await observer.end() } catch { /* already closed */ }
    await cleanup()
    process.exitCode = 1
  }
}

async function startDemo(minutes) {
  const existingPid = livePid()
  if (existingPid) {
    console.log(`Lock Explorer demo is already running (pid ${existingPid}).`)
    await printStatus()
    return
  }

  cleanupRuntimeFiles()
  try { await terminateAndDrop() } catch { /* stale database state is best-effort */ }
  rmSync(LOG_FILE, { force: true })
  const log = openSync(LOG_FILE, "a")
  const child = spawn(process.execPath, [SCRIPT_FILE, "run", `--minutes=${minutes}`], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  })
  child.unref()
  closeSync(log)
  writeFileSync(PID_FILE, `${child.pid}\n`)

  try {
    await waitFor(() => Promise.resolve(existsSync(READY_FILE)), "demo fixture startup", 15_000)
  } catch (error) {
    const logTail = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").slice(-3000) : ""
    throw new Error(`${error.message}\n${logTail}`)
  }

  const ready = JSON.parse(readFileSync(READY_FILE, "utf8"))
  console.log(`Lock Explorer demo started (pid ${ready.pid}).`)
  console.log(`${ready.sessionCount} labeled sessions and ${ready.edgeCount} blocker edges are live until ${ready.expiresAt}.`)
  console.log("Open Data Rabbit -> System -> Lock Explorer.")
  console.log("Stop with: npm run demo:locks:stop")
}

async function stopDemo() {
  const pid = livePid()
  if (pid) {
    try { process.kill(pid, "SIGTERM") } catch { /* process exited */ }
    await delay(600)
  }
  await terminateAndDrop()
  cleanupRuntimeFiles()
  console.log("Lock Explorer demo stopped; sessions and demo schema removed.")
}

async function printStatus() {
  const snapshot = await statusSnapshot()
  if (snapshot.sessions.length === 0) {
    console.log("Lock Explorer demo is not running.")
    return
  }
  console.table(snapshot.sessions.map((session) => ({
    pid: session.pid,
    session: session.application_name.replace(APP_PREFIX, ""),
    state: session.state,
    wait: session.wait_event_type ? `${session.wait_event_type}/${session.wait_event}` : "-",
    xact_s: session.transaction_age_s ?? "-",
  })))
  console.table(snapshot.edges.map((edge) => ({
    blocker: edge.blocker?.replace(APP_PREFIX, "") ?? `pid ${edge.blocker_pid}`,
    waiter: edge.waiter.replace(APP_PREFIX, ""),
  })))
  console.log(`${snapshot.sessions.length} demo sessions; ${snapshot.edges.length} blocker edges.`)
  if (existsSync(READY_FILE)) {
    const ready = JSON.parse(readFileSync(READY_FILE, "utf8"))
    console.log(`Automatic cleanup: ${new Date(ready.expiresAt).toLocaleString()}`)
  }
}

function optionNumber(name, fallback) {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1]
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${name} must be a positive number`)
  return parsed
}

const action = process.argv[2] || "status"

if (action === "run") await runDemo(optionNumber("minutes", DEFAULT_MINUTES))
else if (action === "start") await startDemo(optionNumber("minutes", DEFAULT_MINUTES))
else if (action === "stop") await stopDemo()
else if (action === "status") await printStatus()
else {
  console.error("Usage: node scripts/lock-explorer-demo.mjs <start|status|stop> [--minutes=45]")
  process.exitCode = 2
}
