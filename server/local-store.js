const fs = require('fs/promises');
const path = require('path');

const BASE_DIR = process.env.LOCAL_DATA_DIR
  ? path.resolve(process.env.LOCAL_DATA_DIR)
  : path.join(__dirname, '..', '.local-data');

async function ensureDir(section) {
  const dir = path.join(BASE_DIR, section);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function safeName(value) {
  return encodeURIComponent(String(value));
}

async function writeJson(section, key, data) {
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

async function readJson(section, key) {
  try {
    const file = path.join(BASE_DIR, section, `${safeName(key)}.json`);
    const content = await fs.readFile(file, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function listJson(section) {
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

async function deleteJson(section, key) {
  try {
    const file = path.join(BASE_DIR, section, `${safeName(key)}.json`);
    await fs.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = {
  BASE_DIR,
  writeJson,
  readJson,
  listJson,
  deleteJson,
};
