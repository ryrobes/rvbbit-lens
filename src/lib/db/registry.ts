import "server-only"

import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import type { ConnectionInput, ConnectionRecord } from "./types"

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
    connectionString: input.connectionString?.trim() || existing?.connectionString,
    isDefault: input.isDefault ?? existing?.isDefault ?? false,
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
  return true
}

export function configPathPublic(): string {
  return configPath()
}

/**
 * Strip secrets before serializing for clients. Keeps the *shape* the
 * UI needs (`hasPassword` boolean) without leaking the value.
 */
export function sanitize(c: ConnectionRecord): Omit<ConnectionRecord, "password"> & { hasPassword: boolean } {
  const { password, ...rest } = c
  return { ...rest, hasPassword: typeof password === "string" && password.length > 0 }
}
