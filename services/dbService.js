import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = process.env.AUTH_DB_PATH || path.join(ROOT_DIR, 'data', 'lms.sqlite');

let db = null;

export const getDb = () => {
  if (!db) {
    mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
  }
  return db;
};

export default { getDb };
