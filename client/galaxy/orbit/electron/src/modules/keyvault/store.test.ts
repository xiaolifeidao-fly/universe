import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVault } from './store';

const SECRET = 'sk-galaxy-ABCDEFGHJKMNPQRSTVWXYZ0123456';
const OTHER = 'sk-galaxy-0123456789ABCDEFGHJKMNPQRST';

test('存进去取得回，同一把再存是覆盖', () => {
  const vault = openVault(':memory:');
  vault.save({ ownerId: 'cu_1', keyId: 'ck_a', alias: 'codex-001', secret: SECRET, savedAt: '2026-09-12T00:00:00.000Z' });
  assert.equal(vault.read('cu_1', 'ck_a'), SECRET);
  vault.save({ ownerId: 'cu_1', keyId: 'ck_a', alias: 'codex-002', secret: OTHER, savedAt: '2026-09-12T01:00:00.000Z' });
  assert.equal(vault.read('cu_1', 'ck_a'), OTHER);
  assert.deepEqual(vault.list('cu_1'), [{ keyId: 'ck_a', alias: 'codex-002', savedAt: '2026-09-12T01:00:00.000Z' }]);
  vault.close();
});

test('没有的那一把回空串，不抛错 —— 调用方据此回落到服务端', () => {
  const vault = openVault(':memory:');
  assert.equal(vault.read('cu_1', 'ck_missing'), '');
  assert.deepEqual(vault.list('cu_1'), []);
  vault.close();
});

test('按账号分区：同一台机器上两个使用端账号互相看不见', () => {
  const vault = openVault(':memory:');
  vault.save({ ownerId: 'cu_1', keyId: 'ck_a', alias: '甲', secret: SECRET, savedAt: '2026-09-12T00:00:00.000Z' });
  vault.save({ ownerId: 'cu_2', keyId: 'ck_a', alias: '乙', secret: OTHER, savedAt: '2026-09-12T00:00:00.000Z' });
  assert.equal(vault.read('cu_1', 'ck_a'), SECRET);
  assert.equal(vault.read('cu_2', 'ck_a'), OTHER);
  vault.remove('cu_1', 'ck_a');
  assert.equal(vault.read('cu_1', 'ck_a'), '');
  assert.equal(vault.read('cu_2', 'ck_a'), OTHER);
  vault.close();
});

test('列表按存入时间倒序，新换发的那把排在前面', () => {
  const vault = openVault(':memory:');
  vault.save({ ownerId: 'cu_1', keyId: 'ck_old', alias: '旧', secret: SECRET, savedAt: '2026-09-10T00:00:00.000Z' });
  vault.save({ ownerId: 'cu_1', keyId: 'ck_new', alias: '新', secret: OTHER, savedAt: '2026-09-12T00:00:00.000Z' });
  assert.deepEqual(vault.list('cu_1').map(row => row.keyId), ['ck_new', 'ck_old']);
  vault.close();
});

test('落盘的库权限收到 0600，重开还在', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-vault-'));
  const file = path.join(directory, 'nested', 'key-vault.db');
  try {
    const first = openVault(file);
    first.save({ ownerId: 'cu_1', keyId: 'ck_a', alias: 'codex-001', secret: SECRET, savedAt: '2026-09-12T00:00:00.000Z' });
    first.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    const second = openVault(file);
    assert.equal(second.read('cu_1', 'ck_a'), SECRET);
    second.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('库文件坏了挪到一边重建，不删 —— 里面那份明文服务端未必取得回', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-vault-'));
  const file = path.join(directory, 'key-vault.db');
  try {
    fs.writeFileSync(file, 'this is not a sqlite database');
    const vault = openVault(file);
    vault.save({ ownerId: 'cu_1', keyId: 'ck_a', alias: 'codex-001', secret: SECRET, savedAt: '2026-09-12T00:00:00.000Z' });
    assert.equal(vault.read('cu_1', 'ck_a'), SECRET);
    vault.close();
    const kept = fs.readdirSync(directory).filter(name => name.includes('.corrupt-'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, kept[0]), 'utf8'), 'this is not a sqlite database');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
