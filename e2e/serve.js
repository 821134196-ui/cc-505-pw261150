/**
 * E2E 服务入口：每次启动都用全新的演示数据库，
 * 保证测试独立、可重复。仅用于测试，不要用于生产。
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/lib/db.js';
import { createApp } from '../server/index.js';
import { seedWithDraft } from '../server/seed.js';

const dbPath = process.env.DB_PATH || '/tmp/signal-loop-e2e.db';
for (const suffix of ['', '-wal', '-shm']) {
  fs.rmSync(dbPath + suffix, { force: true });
}

const db = openDb(dbPath);
seedWithDraft(db);

const app = createApp({ db, staticDir: path.join(process.cwd(), 'dist') });
const port = Number(process.env.PORT) || 8799;
app.listen(port, () => {
  console.log(`[e2e] listening on ${port}, db=${dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { db.close(); process.exit(0); });
}
