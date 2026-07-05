import "server-only"

import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import type { ConnectionInput, ConnectionRecord } from "./types"
import { disposeTunnel } from "./tunnel"

/**
 * Filesystem-backed connection registry. Single JSON file, mode 0600.
 * Designed so the *user* owns their secrets — exactly like ~/.pgpass.
 */

const ENV_HOME = "RVBBIT_LENS_HOME"
const DEFAULT_DIR_NAME = "rvbbit-lens"
const FILE_NAME = "connections.json"

function configDir(): string {
  const fromEnv = process.env[ENV_HOME]
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, DEFAULT_DIR_NAME)
}

function configPath(): string {
  return path.join(configDir(), FILE_NAME)
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 })
}

async function readAll(): Promise<ConnectionRecord[]> {
  const file = configPath()
  try {
    const raw = await fs.readFile(file, "utf-8")
    const parsed = JSON.parse(raw) as { connections?: ConnectionRecord[] } | ConnectionRecord[]
    const list = Array.isArray(parsed) ? parsed : parsed?.connections ?? []
    return list.filter((c) => c && typeof c.id === "string")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

async function writeAll(connections: ConnectionRecord[]): Promise<void> {
  await ensureDir()
  const file = configPath()
  const tmp = `${file}.tmp`
  const body = JSON.stringify({ version: 1, connections }, null, 2)
  await fs.writeFile(tmp, body, { mode: 0o600 })
  await fs.rename(tmp, file)
}

/**
 * Blank the password in a connection string so it can be shown to clients. Handles
 * both URL form (`postgresql://user:pass@host/db`) and libpq keyword form
 * (`host=… password=secret …`). Reports whether a password was present so
 * `hasPassword` can reflect a URL-embedded secret too.
 */
export function redactConnString(cs: string | undefined): { redacted: string | undefined; hadPassword: boolean } {
  if (!cs) return { redacted: cs, hadPassword: false }
  try {
    const url = new URL(cs)
    const hadPassword = url.password.length > 0
    if (hadPassword) url.password = "***"
    return { redacted: hadPassword ? url.toString() : cs, hadPassword }
  } catch {
    const pwRe = /(\bpassword\s*=\s*)('(?:[^']|'')*'|\S+)/i
    const hadPassword = pwRe.test(cs)
    return { redacted: hadPassword ? cs.replace(pwRe, "$1***") : cs, hadPassword }
  }
}

/**
 * The UI is shown a redacted connection string. If it echoes that exact
 * redaction back on save (i.e. the user didn't retype it), keep the stored
 * secret instead of overwriting the password with the `***` sentinel.
 */
function chooseConnString(incoming: string | undefined, existing: string | undefined): string | undefined {
  const trimmed = incoming?.trim()
  if (!trimmed) return existing
  if (existing && redactConnString(existing).redacted === trimmed) return existing
  return trimmed
}

function normalizeInput(input: ConnectionInput, existing?: ConnectionRecord): ConnectionRecord {
  const now = new Date().toISOString()
  return {
    id: input.id ?? existing?.id ?? randomUUID(),
    label: input.label.trim() || existing?.label || "untitled",
    host: input.host?.trim() || existing?.host || "localhost",
    port: input.port ?? existing?.port ?? 5432,
    database: input.database?.trim() || existing?.database || "postgres",
    user: input.user?.trim() || existing?.user || "postgres",
    password: input.password ?? existing?.password,
    sslMode: input.sslMode ?? existing?.sslMode ?? "prefer",
    connectionString: chooseConnString(input.connectionString, existing?.connectionString),
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
    // SSH tunnel. Non-secret fields fall back to existing; secrets use `??` so an
    // edit that omits them (the form sends undefined when left blank) keeps the
    // stored value — exactly like `password` above.
    sshEnabled: input.sshEnabled ?? existing?.sshEnabled ?? false,
    // Non-secret fields: distinguish "omitted" (undefined → keep existing) from
    // "cleared" (present empty string → drop), so blanking the key path actually
    // sticks. Secrets below stay write-only (`?? existing`).
    sshHost: input.sshHost !== undefined ? input.sshHost.trim() || undefined : existing?.sshHost,
    sshPort: input.sshPort ?? existing?.sshPort,
    sshUser: input.sshUser !== undefined ? input.sshUser.trim() || undefined : existing?.sshUser,
    sshKeyPath: input.sshKeyPath !== undefined ? input.sshKeyPath.trim() || undefined : existing?.sshKeyPath,
    sshPrivateKey: input.sshPrivateKey ?? existing?.sshPrivateKey,
    sshPassphrase: input.sshPassphrase ?? existing?.sshPassphrase,
    sshPassword: input.sshPassword ?? existing?.sshPassword,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
}

export async function listConnections(): Promise<ConnectionRecord[]> {
  return readAll()
}

export async function getConnection(id: string): Promise<ConnectionRecord | null> {
  const all = await readAll()
  return all.find((c) => c.id === id) ?? null
}

export async function upsertConnection(input: ConnectionInput): Promise<ConnectionRecord> {
  const all = await readAll()
  const existingIdx = input.id ? all.findIndex((c) => c.id === input.id) : -1
  const next = normalizeInput(input, existingIdx >= 0 ? all[existingIdx] : undefined)

  // If this connection becomes default, clear the flag on others.
  if (next.isDefault) {
    for (const c of all) if (c.id !== next.id) c.isDefault = false
  }

  if (existingIdx >= 0) {
    all[existingIdx] = next
  } else {
    all.push(next)
  }

  await writeAll(all)
  return next
}

export async function deleteConnection(id: string): Promise<boolean> {
  const all = await readAll()
  const next = all.filter((c) => c.id !== id)
  if (next.length === all.length) return false
  await writeAll(next)
  // The record is gone, so ensureTunnel will never be called for this id again —
  // tear down any live tunnel now or its bastion session + local port leak forever.
  disposeTunnel(id)
  return true
}

export function configPathPublic(): string {
  return configPath()
}

/**
 * Strip secrets before serializing for clients. Keeps the *shape* the
 * UI needs (`has*` booleans) without leaking the values. The SSH key path is
 * NOT a secret (it's a local filename) so it stays; the key/passphrase/password
 * are stripped exactly like the DB password.
 */
export type SanitizedConnection = Omit<
  ConnectionRecord,
  "password" | "sshPrivateKey" | "sshPassphrase" | "sshPassword"
> & {
  hasPassword: boolean
  hasSshPrivateKey: boolean
  hasSshPassphrase: boolean
  hasSshPassword: boolean
}

export function sanitize(c: ConnectionRecord): SanitizedConnection {
  const { password, sshPrivateKey, sshPassphrase, sshPassword, ...rest } = c
  const set = (v: unknown) => typeof v === "string" && v.length > 0
  // A password can hide inside connectionString (`postgresql://u:pass@host`);
  // redact it and fold it into hasPassword so the secret never reaches the client.
  const { redacted, hadPassword } = redactConnString(rest.connectionString)
  return {
    ...rest,
    connectionString: redacted,
    hasPassword: set(password) || hadPassword,
    hasSshPrivateKey: set(sshPrivateKey),
    hasSshPassphrase: set(sshPassphrase),
    hasSshPassword: set(sshPassword),
  }
}
