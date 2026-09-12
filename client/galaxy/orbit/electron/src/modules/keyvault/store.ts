/**
 * 本机密钥保险箱的 SQLite 那一半：只管一张表怎么读写，路径、权限和参数校验在
 * impl/keyvault.impl.ts。拆出来是为了能在 node --test 里对着 :memory: 跑完整的增删改查 ——
 * 这里存的是签发之后**唯一**的一份明文，写丢了用户只能换发，不能重来。
 *
 * 用 node:sqlite（Node 22.5+ 内置，Electron 40 跑的是 Node 24）：不引原生依赖，
 * 就不用为每个 Electron 版本重编一次 better-sqlite3，打包脚本也不用改。
 */

import fs from 'node:fs';
import path from 'node:path';

// node:sqlite 的类型要 @types/node 22+，仓库里现在钉在 20，所以按用到的两三个方法自己描述、
// 用 require 拿进来。等哪天整个 galaxy 工作区把 @types/node 升上去，这一段可以整个删掉。
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteModule = { DatabaseSync: new (location: string) => SqliteDatabase };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS key_secret (
  owner_id TEXT NOT NULL,
  key_id   TEXT NOT NULL,
  alias    TEXT NOT NULL DEFAULT '',
  secret   TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, key_id)
) WITHOUT ROWID;
`;

export interface VaultEntry {
  keyId: string;
  alias: string;
  savedAt: string;
}

export interface VaultRecord extends VaultEntry {
  ownerId: string;
  secret: string;
}

export interface Vault {
  /** 这个账号在本机存过哪些密钥。不回明文 —— 页面画卡片只要知道「有没有」。 */
  list(ownerId: string): VaultEntry[];
  /** 没有这一把时回空串，由调用方回落到服务端取。 */
  read(ownerId: string, keyId: string): string;
  save(record: VaultRecord): void;
  remove(ownerId: string, keyId: string): void;
  close(): void;
}

function text(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  return typeof value === 'string' ? value : '';
}

/**
 * 打开（必要时新建）保险箱。
 *
 * 库文件坏了就整个挪到一边再重建，而不是删掉：里面那些明文服务端未必取得回，
 * 留一份坏文件在原地，至少还有人工捞出来的可能。
 */
export function openVault(file: string): Vault {
  const { DatabaseSync } = require('node:sqlite') as SqliteModule;
  const memory = file === ':memory:';
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });

  let database: SqliteDatabase;
  try {
    database = new DatabaseSync(file);
    database.exec(SCHEMA);
  } catch (error) {
    if (memory) throw error;
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    database = new DatabaseSync(file);
    database.exec(SCHEMA);
  }
  // 文件里是能直接花钱的明文，别让同机器上的其他用户读到。
  if (!memory) fs.chmodSync(file, 0o600);

  const listStatement = database.prepare('SELECT key_id, alias, saved_at FROM key_secret WHERE owner_id = ? ORDER BY saved_at DESC');
  const readStatement = database.prepare('SELECT secret FROM key_secret WHERE owner_id = ? AND key_id = ?');
  const saveStatement = database.prepare(
    'INSERT INTO key_secret (owner_id, key_id, alias, secret, saved_at) VALUES (?, ?, ?, ?, ?)'
      + ' ON CONFLICT(owner_id, key_id) DO UPDATE SET alias = excluded.alias, secret = excluded.secret, saved_at = excluded.saved_at',
  );
  const removeStatement = database.prepare('DELETE FROM key_secret WHERE owner_id = ? AND key_id = ?');

  return {
    list(ownerId) {
      return listStatement.all(ownerId).map(row => ({
        keyId: text(row, 'key_id'),
        alias: text(row, 'alias'),
        savedAt: text(row, 'saved_at'),
      }));
    },
    read(ownerId, keyId) {
      return text(readStatement.get(ownerId, keyId) ?? {}, 'secret');
    },
    save(record) {
      saveStatement.run(record.ownerId, record.keyId, record.alias, record.secret, record.savedAt);
    },
    remove(ownerId, keyId) {
      removeStatement.run(ownerId, keyId);
    },
    close() {
      database.close();
    },
  };
}
