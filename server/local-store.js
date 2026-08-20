const fs = require('fs/promises');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const db = require('./db');
const postgresStore = require('./db/postgres-store');

const BASE_DIR = process.env.LOCAL_DATA_DIR
  ? path.resolve(process.env.LOCAL_DATA_DIR)
  : path.join(__dirname, '..', '.local-data');
const transactionContext = new AsyncLocalStorage();

function currentClient() {
  return transactionContext.getStore() || undefined;
}

async function ensureDir(section) {
  const dir = path.join(BASE_DIR, section);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function safeName(value) {
  return encodeURIComponent(String(value));
}

async function writeLegacyJson(section, key, data) {
  const dir = await ensureDir(section);
  const file = path.join(dir, `${safeName(key)}.json`);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
  });
  await fs.rename(temporary, file);
  return data;
}

async function readLegacyJson(section, key) {
  try {
    const file = path.join(BASE_DIR, section, `${safeName(key)}.json`);
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function listLegacyJson(section) {
  try {
    const dir = path.join(BASE_DIR, section);
    const files = await fs.readdir(dir);
    const items = [];

    for (const file of files.filter((name) => name.endsWith('.json'))) {
      try {
        const content = await fs.readFile(path.join(dir, file), 'utf8');
        items.push(JSON.parse(content));
      } catch (error) {
        error.message = `No se pudo leer ${section}/${file}: ${error.message}`;
        throw error;
      }
    }

    return items;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function deleteLegacyJson(section, key) {
  try {
    const file = path.join(BASE_DIR, section, `${safeName(key)}.json`);
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJson(section, key, data) {
  if (db.usingPostgres()) return postgresStore.writeJson(section, key, data, currentClient());
  return writeLegacyJson(section, key, data);
}

async function readJson(section, key) {
  if (db.usingPostgres()) return postgresStore.readJson(section, key, currentClient());
  return readLegacyJson(section, key);
}

async function listJson(section) {
  if (db.usingPostgres()) return postgresStore.listJson(section, currentClient());
  return listLegacyJson(section);
}

async function deleteJson(section, key) {
  if (db.usingPostgres()) return postgresStore.deleteJson(section, key, currentClient());
  return deleteLegacyJson(section, key);
}

async function withTransaction(callback) {
  if (!db.usingPostgres()) return callback();
  return db.transaction((client) => transactionContext.run(client, callback));
}

module.exports = {
  BASE_DIR,
  deleteLegacyJson,
  writeJson,
  writeLegacyJson,
  readJson,
  readLegacyJson,
  listJson,
  listLegacyJson,
  deleteJson,
  usesPostgres: db.usingPostgres,
  withTransaction,
};
