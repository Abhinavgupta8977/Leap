import express from 'express';
import http from 'http';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { MongoClient, Db } from 'mongodb';

dotenv.config();

const app = express();
app.use(bodyParser.json());

const server = http.createServer(app);

// Simple in-memory SSE client registry
type SSEClient = {
  id: string;
  companyId?: string;
  surveyId?: string;
  res: express.Response;
};

const sseClients = new Map<string, SSEClient[]>();

// MongoDB setup
const MONGODB_URI = process.env.MONGODB_URI || process.env.VITE_MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB = process.env.MONGODB_DB || process.env.VITE_MONGODB_DATABASE || 'leap-survey';

let mongoClient: MongoClient;
let db: Db;

async function connectMongo() {
  mongoClient = new MongoClient(MONGODB_URI, { connectTimeoutMS: 10000 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB);
  console.log('Connected to MongoDB', MONGODB_URI, 'db=', MONGODB_DB);
}

// Simple JWT auth middleware for API endpoints
function jwtAuthRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Authorization header required' });
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret') as any;
    (req as any).auth = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// SSE subscribe endpoint
app.get('/sse', (req, res) => {
  // Allow token in query or Authorization header
  const token = (req.query.token as string) || (req.headers.authorization && String(req.headers.authorization).startsWith('Bearer ') ? String(req.headers.authorization).split(' ')[1] : undefined);
  let companyId: string | undefined = undefined;
  let surveyId: string | undefined = undefined;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret') as any;
      companyId = String(payload.companyId);
    } catch (err) {
      // ignore, allow anonymous subscribe if companyId query param provided
    }
  }
  if (!companyId && req.query.companyId) companyId = String(req.query.companyId);
  if (req.query.surveyId) surveyId = String(req.query.surveyId);

  // Set SSE headers
  res.writeHead(200, {
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  res.flushHeaders?.();

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const client: SSEClient = { id, companyId, surveyId, res };
  const key = companyId || '__all__';
  const arr = sseClients.get(key) || [];
  arr.push(client);
  sseClients.set(key, arr);

  // send a comment to keep connection alive
  res.write(':connected\n\n');

  req.on('close', () => {
    const list = sseClients.get(key) || [];
    sseClients.set(key, list.filter((c) => c.id !== id));
  });
});

// helper to publish events to SSE clients
function publishEvent(event: string, data: any) {
  const companyKey = data.companyId ? String(data.companyId) : '__all__';
  const targets = (sseClients.get(companyKey) || []).concat(sseClients.get('__all__') || []);
  const text = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  targets.forEach((client) => {
    try {
      // if client subscribed to a specific survey, filter
      if (client.surveyId && data.surveyId && String(client.surveyId) !== String(data.surveyId)) return;
      client.res.write(text);
    } catch (err) {
      // ignore write errors
    }
  });
}

// API: submit a survey response
app.post('/api/responses', jwtAuthRequired, async (req, res) => {
  try {
    const payload = (req as any).auth as any;
    const { companyId, surveyId, respondentId, answers } = req.body;
    if (!companyId || !surveyId || !answers) return res.status(400).json({ error: 'companyId, surveyId and answers required' });
    if (String(payload.companyId) !== String(companyId)) return res.status(403).json({ error: 'Token not valid for companyId' });

    const responses = db.collection('responses');
    const doc = { companyId: String(companyId), surveyId: String(surveyId), respondentId: respondentId || null, answers, createdAt: new Date() };
    const result = await responses.insertOne(doc);
    const saved = { _id: result.insertedId, ...doc };

    // publish to SSE clients
    publishEvent('response:created', { response: saved, companyId, surveyId });

    return res.json({ ok: true, response: saved });
  } catch (err: any) {
    console.error('POST /api/responses error', err);
    return res.status(500).json({ error: err.message || 'internal server error' });
  }
});

// API: fetch responses
app.get('/api/responses', async (req, res) => {
  try {
    const { companyId, surveyId, limit = '100' } = req.query;
    if (!companyId) return res.status(400).json({ error: 'companyId required' });
    const responses = db.collection('responses');
    const q: any = { companyId: String(companyId) };
    if (surveyId) q.surveyId = String(surveyId);
    const docs = await responses.find(q).sort({ createdAt: -1 }).limit(Number(limit)).toArray();
    return res.json({ ok: true, responses: docs });
  } catch (err: any) {
    console.error('GET /api/responses error', err);
    return res.status(500).json({ error: err.message || 'internal server error' });
  }
});

// Simple health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = Number(process.env.PORT || 4000);

async function start() {
  await connectMongo();
  if (process.env.NODE_ENV !== 'test') {
    server.listen(PORT, () => console.log(`SSE + Mongo server listening on ${PORT}`));
  }
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});

// graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  try { await mongoClient?.close(); } catch (e) {}
  server.close(() => process.exit(0));
});

export { app, server };