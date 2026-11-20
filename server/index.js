import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from './lib/db.js';
import {
  ApiError, listSeries, listAnomalies, getAnomaly, createFeedback, revokeFeedback,
  listVersions, getVersion, createDraftVersion, activateVersion, scanObservations,
  listAudit, metrics, listFeedbackForAnomaly,
} from './lib/service.js';

export function createApp({ db, staticDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // 演示环境：分析人员身份由请求头携带；生产应替换为会话鉴权
  app.use((req, _res, next) => {
    const header = req.get('x-analyst');
    let name = '分析员';
    if (header) {
      try { name = decodeURIComponent(header); } catch { name = header; }
    }
    req.actor = String(name).slice(0, 80) || '分析员';
    next();
  });

  const wrap = (fn) => (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ ok: true }));
  api.get('/me', (req, res) => res.json({ actor: req.actor }));

  api.get('/series', wrap((_req, res) => res.json({ series: listSeries(db) })));

  api.get('/metrics', wrap((_req, res) => res.json(metrics(db))));

  api.get('/anomalies', wrap((req, res) => {
    const anomalies = listAnomalies(db, req.query);
    res.json({ anomalies, total: anomalies.length });
  }));

  api.get('/anomalies/:id', wrap((req, res) => {
    res.json(getAnomaly(db, req.params.id));
  }));

  api.get('/anomalies/:id/feedback', wrap((req, res) => {
    res.json({ feedback: listFeedbackForAnomaly(db, req.params.id) });
  }));

  api.post('/anomalies/:id/feedback', wrap((req, res) => {
    const result = createFeedback(db, req.params.id, req.body, { actor: req.actor });
    res.status(result.replayed ? 200 : 201).json(result);
  }));

  api.post('/feedback/:id/revoke', wrap((req, res) => {
    const result = revokeFeedback(db, req.params.id, req.body, { actor: req.actor });
    res.status(result.replayed ? 200 : 200).json(result);
  }));

  api.get('/versions', wrap((_req, res) => res.json({ versions: listVersions(db) })));

  api.get('/versions/:id', wrap((req, res) => res.json(getVersion(db, req.params.id))));

  api.post('/versions', wrap((req, res) => {
    const result = createDraftVersion(db, req.body, { actor: req.actor });
    res.status(201).json(result);
  }));

  api.post('/versions/:id/activate', wrap((req, res) => {
    res.json(activateVersion(db, req.params.id, req.body, { actor: req.actor }));
  }));

  api.get('/versions/:id/backtests', wrap((req, res) => {
    res.json({ backtests: getVersion(db, req.params.id).backtests });
  }));

  api.post('/scan', wrap((req, res) => {
    res.json(scanObservations(db, { actor: req.actor }));
  }));

  api.get('/audit', wrap((req, res) => {
    res.json({ events: listAudit(db, Number(req.query.limit) || 100) });
  }));

  app.use('/api', api);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
  });

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details ?? null },
      });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON' } });
    }
    console.error(err);
    return res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const db = openDb();
  const app = createApp({ db, staticDir: path.join(process.cwd(), 'dist') });
  const port = Number(process.env.PORT) || 8787;
  app.listen(port, () => {
    console.log(`Signal Loop API 已启动: http://localhost:${port}`);
  });
}
