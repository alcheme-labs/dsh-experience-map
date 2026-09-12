import { open, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ExperienceError } from '../errors.js'
import {
  EXPERIENCE_DB_APPLICATION_ID,
  EXPERIENCE_DB_SCHEMA_SQL,
  EXPERIENCE_DB_SCHEMA_VERSION,
  EXPERIENCE_DB_TABLES,
} from './schema.js'

/** Supported canonical journal modes. */
export type ExperienceJournalMode = 'wal' | 'delete' | 'truncate' | 'persist'
/** Supported SQLite durability levels. */
export type ExperienceSynchronous = 'normal' | 'full'

/** Validated storage configuration. */
export interface DatabaseConfig {
  readonly databasePath: string
  readonly journalMode: ExperienceJournalMode
  readonly synchronous: ExperienceSynchronous
  readonly busyTimeoutMs: number
  readonly maxPendingWrites: number
}

/** One owned SQLite connection and its bounded serial write queue. */
export class ExperienceDatabase {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private closing = false

  private constructor(
    readonly handle: DatabaseSync,
    readonly path: string,
    private readonly maxPendingWrites: number,
  ) {}

  /** Open, validate, or atomically bootstrap the canonical database. */
  static async open(config: DatabaseConfig): Promise<ExperienceDatabase> {
    validateConfig(config)
    const actual = config.databasePath === ':memory:' ? ':memory:' : resolve(config.databasePath)
    if (actual !== ':memory:') await ensureOwnerOnlyFile(actual)
    const { DatabaseSync } = await import('node:sqlite')
    const handle: DatabaseSync = new DatabaseSync(actual)
    try {
      const applicationId = pragmaNumber(handle, 'application_id')
      const version = pragmaNumber(handle, 'user_version')
      const tables = listTables(handle)
      if (applicationId !== 0 && applicationId !== EXPERIENCE_DB_APPLICATION_ID) {
        throw new ExperienceError(
          'database_foreign_application',
          `Experience database at "${actual}" belongs to another application`,
        )
      }
      if (applicationId === 0 && tables.length > 0) {
        throw new ExperienceError(
          'database_schema_invalid',
          `Experience database at "${actual}" is non-empty but has no Experience application id`,
        )
      }
      if (applicationId === EXPERIENCE_DB_APPLICATION_ID && version > EXPERIENCE_DB_SCHEMA_VERSION) {
        throw new ExperienceError(
          'database_newer_schema',
          `Experience database schema ${String(version)} is newer than supported ${String(EXPERIENCE_DB_SCHEMA_VERSION)}`,
        )
      }
      if (applicationId === EXPERIENCE_DB_APPLICATION_ID && version < EXPERIENCE_DB_SCHEMA_VERSION) {
        throw new ExperienceError(
          'database_schema_invalid',
          `Experience database schema ${String(version)} is pre-release data; remove it before starting schema ${String(EXPERIENCE_DB_SCHEMA_VERSION)}`,
        )
      }
      configure(handle, config)
      if (applicationId === 0) bootstrap(handle)
      else assertSchema(handle, tables)
      return new ExperienceDatabase(handle, actual, config.maxPendingWrites)
    } catch (error) {
      handle.close()
      throw error
    }
  }

  /** Run one BEGIN IMMEDIATE transaction after earlier writes settle. */
  async write<T>(work: (handle: DatabaseSync) => T): Promise<T> {
    if (this.closing) throw new ExperienceError('internal', 'Experience database is closing')
    if (this.pending >= this.maxPendingWrites) {
      throw new ExperienceError('database_busy', 'Experience write queue is full')
    }
    this.pending++
    let release!: () => void
    const predecessor = this.tail
    this.tail = new Promise<void>(resolveTail => { release = resolveTail })
    await predecessor
    try {
      try {
        this.handle.exec('BEGIN IMMEDIATE')
      } catch (error) {
        throw normalizeSqliteFailure(error)
      }
      try {
        const result = work(this.handle)
        this.handle.exec('COMMIT')
        return result
      } catch (error) {
        this.handle.exec('ROLLBACK')
        throw normalizeSqliteFailure(error)
      }
    } finally {
      this.pending--
      release()
    }
  }

  /** Drain accepted writes, then close the sole connection. */
  async close(): Promise<void> {
    if (this.closing) {
      await this.tail
      return
    }
    this.closing = true
    await this.tail
    this.handle.close()
  }
}

function normalizeSqliteFailure(error: unknown): unknown {
  if (error instanceof ExperienceError) return error
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { errcode?: unknown; message?: unknown }
    const message = typeof candidate.message === 'string' ? candidate.message : ''
    if (candidate.errcode === 5 || candidate.errcode === 6 || /database is (?:locked|busy)/iu.test(message)) {
      return new ExperienceError('database_busy', 'Experience database is busy', {}, { cause: error })
    }
  }
  return error
}

async function ensureOwnerOnlyFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const mode = (await stat(path)).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new ExperienceError(
      'database_permissions_unsafe',
      `Experience database at "${path}" is accessible by group or other users`,
      { mode: mode.toString(8) },
    )
  }
}

function validateConfig(config: DatabaseConfig): void {
  if (config.databasePath.trim() === '') throw new ExperienceError('invalid_command', 'databasePath is required')
  if (!Number.isSafeInteger(config.busyTimeoutMs) || config.busyTimeoutMs < 0) {
    throw new ExperienceError('invalid_command', 'busyTimeoutMs must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(config.maxPendingWrites) || config.maxPendingWrites < 1) {
    throw new ExperienceError('invalid_command', 'maxPendingWrites must be a positive safe integer')
  }
}

function configure(handle: DatabaseSync, config: DatabaseConfig): void {
  handle.exec('PRAGMA foreign_keys = ON')
  handle.exec(`PRAGMA busy_timeout = ${String(config.busyTimeoutMs)}`)
  handle.exec(`PRAGMA journal_mode = ${config.journalMode.toUpperCase()}`)
  handle.exec(`PRAGMA synchronous = ${config.synchronous.toUpperCase()}`)
}

function bootstrap(handle: DatabaseSync): void {
  handle.exec('BEGIN IMMEDIATE')
  try {
    handle.exec(EXPERIENCE_DB_SCHEMA_SQL)
    handle.exec('INSERT INTO commit_sequence (singleton, next_value) VALUES (1, 1)')
    handle.exec(`PRAGMA application_id = ${String(EXPERIENCE_DB_APPLICATION_ID)}`)
    handle.exec(`PRAGMA user_version = ${String(EXPERIENCE_DB_SCHEMA_VERSION)}`)
    handle.exec('COMMIT')
  } catch (error) {
    handle.exec('ROLLBACK')
    throw error
  }
  assertSchema(handle, listTables(handle))
}

function assertSchema(handle: DatabaseSync, tables: readonly string[]): void {
  const expected = [...EXPERIENCE_DB_TABLES].sort()
  const actual = [...tables].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new ExperienceError('database_schema_invalid', 'Experience database table set is not recognized', {
      missing: expected.filter(name => !actual.includes(name)),
      unknown: actual.filter(name => !expected.includes(name as typeof EXPERIENCE_DB_TABLES[number])),
    })
  }
  const nonStrict = handle.prepare(
    `SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table'
       AND name NOT GLOB 'sqlite_*' AND strict <> 1 ORDER BY name`,
  ).all() as Array<{ name: string }>
  if (nonStrict.length > 0) {
    throw new ExperienceError('database_schema_invalid', 'Experience database contains non-STRICT tables', {
      tables: nonStrict.map(row => row.name),
    })
  }
  const broken = handle.prepare('PRAGMA foreign_key_check').all()
  if (broken.length > 0) {
    throw new ExperienceError('database_schema_invalid', 'Experience database foreign keys are inconsistent')
  }
}

function pragmaNumber(handle: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = handle.prepare(`PRAGMA ${name}`).get() as Record<string, number>
  return row[name] ?? 0
}

function listTables(handle: DatabaseSync): string[] {
  return (handle.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>).map(row => row.name)
}
