const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TCP_PORT = Number(process.env.TCP_PORT || 9100);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3100);
const PUBLIC_DIR = path.join(__dirname, 'public');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const LOG_DIR = path.join(__dirname, 'logs');
const MAX_PENDING_AGE_MS = 20000;
const DEFAULT_STRENGTH = 75;

const sessions = new Map();
const pendingSessions = [];
let tcpServer = null;
let httpServer = null;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function logEvent(level, message, extra = {}) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
    ...extra,
  };

  console.log(`[${timestamp}] ${level.toUpperCase()} ${message}`);

  const logFile = path.join(LOG_DIR, 'receiver.log');
  fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

function getSessionRecord(session) {
  return {
    id: session.id,
    remoteAddress: session.remoteAddress,
    connectedAt: session.connectedAt,
    status: session.status,
    strength: session.strength,
    bytesReceived: session.bytesReceived,
    lastActivity: session.lastActivity,
    reason: session.reason || null,
  };
}

function getStatus() {
  const active = [];
  const pending = [];

  for (const session of sessions.values()) {
    const record = getSessionRecord(session);
    if (session.status === 'accepted') {
      active.push(record);
    } else if (session.status === 'pending') {
      pending.push(record);
    }
  }

  return {
    ok: true,
    server: {
      tcpPort: TCP_PORT,
      httpPort: HTTP_PORT,
      running: !!tcpServer,
      uptimeMs: Date.now() - appStartTime,
    },
    pending,
    active,
    total: sessions.size,
  };
}

function rejectSocket(session, reason) {
  if (!session || !session.socket) return;
  session.status = 'rejected';
  session.reason = reason;
  session.lastActivity = Date.now();
  try {
    session.socket.destroy();
  } catch (error) {
    logEvent('warn', 'Socket destroy failed', { id: session.id, error: error.message });
  }
}

function stopSocket(session, reason) {
  if (!session || !session.socket) return;
  session.status = 'stopped';
  session.reason = reason;
  session.lastActivity = Date.now();
  try {
    session.socket.destroy();
  } catch (error) {
    logEvent('warn', 'Socket stop failed', { id: session.id, error: error.message });
  }
}

function acceptSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, message: 'Session not found' };
  }

  if (session.status !== 'pending') {
    return { ok: false, message: 'Session is not pending' };
  }

  session.status = 'accepted';
  session.acceptedAt = Date.now();
  session.lastActivity = Date.now();
  session.filePath = path.join(RECORDINGS_DIR, `${session.id}.bin`);
  session.stream = fs.createWriteStream(session.filePath, { flags: 'a' });

  logEvent('info', 'Session accepted', {
    id: session.id,
    remoteAddress: session.remoteAddress,
  });

  return { ok: true };
}

function updateStrength(sessionId, strength) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, message: 'Session not found' };
  }

  const value = Math.max(0, Math.min(100, Number(strength) || DEFAULT_STRENGTH));
  session.strength = value;
  session.lastActivity = Date.now();
  return { ok: true, strength: value };
}

function pruneExpiredPendingSessions() {
  const now = Date.now();
  for (const session of Array.from(sessions.values())) {
    if (session.status === 'pending' && now - session.connectedAt > MAX_PENDING_AGE_MS) {
      rejectSocket(session, 'timeout');
    }
  }
}

function removeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.stream && !session.stream.destroyed) {
    session.stream.end();
  }

  sessions.delete(sessionId);
  const pendingIndex = pendingSessions.indexOf(session);
  if (pendingIndex >= 0) {
    pendingSessions.splice(pendingIndex, 1);
  }

  logEvent('info', 'Session removed', {
    id: sessionId,
    remoteAddress: session.remoteAddress,
  });
}

function handleSocketData(session, chunk) {
  if (session.status !== 'accepted') {
    session.bytesReceived += chunk.length;
    session.lastActivity = Date.now();
    return;
  }

  session.bytesReceived += chunk.length;
  session.lastActivity = Date.now();

  if (session.stream && !session.stream.destroyed) {
    session.stream.write(chunk);
  }
}

function handleNewSocket(socket) {
  const sessionId = `session_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const session = {
    id: sessionId,
    socket,
    remoteAddress: socket.remoteAddress || 'unknown',
    connectedAt: Date.now(),
    acceptedAt: null,
    status: 'pending',
    strength: DEFAULT_STRENGTH,
    bytesReceived: 0,
    lastActivity: Date.now(),
    reason: null,
    filePath: null,
    stream: null,
  };

  sessions.set(sessionId, session);
  pendingSessions.push(session);

  logEvent('info', 'Client connected', {
    id: sessionId,
    remoteAddress: session.remoteAddress,
  });

  socket.on('data', (chunk) => {
    try {
      handleSocketData(session, chunk);
    } catch (error) {
      logEvent('error', 'Socket data handling failed', {
        id: sessionId,
        error: error.message,
      });
      rejectSocket(session, 'data_process_error');
    }
  });

  socket.on('end', () => {
    logEvent('info', 'Socket ended', { id: sessionId, remoteAddress: session.remoteAddress });
    removeSession(sessionId);
  });

  socket.on('close', () => {
    if (sessions.has(sessionId)) {
      removeSession(sessionId);
    }
  });

  socket.on('error', (error) => {
    logEvent('error', 'Socket error', {
      id: sessionId,
      remoteAddress: session.remoteAddress,
      error: error.message,
    });
    removeSession(sessionId);
  });
}

function serveStaticFile(filePath, res) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
    };

    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function onHttpRequest(req, res) {
  const method = req.method || 'GET';
  const url = new URL(req.url, 'http://localhost');

  if (method === 'GET' && url.pathname === '/') {
    serveStaticFile(path.join(PUBLIC_DIR, 'index.html'), res);
    return;
  }

  if (method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getStatus()));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/public/')) {
    const filePath = path.join(PUBLIC_DIR, url.pathname.replace(/^\/public\//, ''));
    serveStaticFile(filePath, res);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/decision') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const { id, action, strength } = data;

        if (!id || !action) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: 'Missing id or action' }));
          return;
        }

        const session = sessions.get(id);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, message: 'Session not found' }));
          return;
        }

        if (action === 'accept') {
          const result = acceptSession(id);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        if (action === 'reject') {
          rejectSocket(session, 'rejected_by_admin');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: 'Session rejected' }));
          return;
        }

        if (action === 'stop') {
          stopSocket(session, 'stopped_by_admin');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, message: 'Session stopped' }));
          return;
        }

        if (action === 'strength') {
          const result = updateStrength(id, strength);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Unknown action' }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: 'Invalid JSON body' }));
      }
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/server/stop') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: 'Server stop requested' }));
    setTimeout(() => {
      for (const session of sessions.values()) {
        try {
          session.socket.destroy();
        } catch (error) {}
      }

      if (httpServer) httpServer.close();
      if (tcpServer) tcpServer.close();
      process.exit(0);
    }, 200);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function startHttpServer() {
  httpServer = http.createServer(onHttpRequest);
  httpServer.listen(HTTP_PORT, () => {
    logEvent('info', 'HTTP dashboard started', { port: HTTP_PORT });
  });
}

function startTcpServer() {
  tcpServer = net.createServer({ allowHalfOpen: false }, (socket) => {
    handleNewSocket(socket);
  });

  tcpServer.on('error', (error) => {
    logEvent('error', 'TCP server error', { error: error.message });
  });

  tcpServer.listen(TCP_PORT, () => {
    logEvent('info', 'TCP server listening', { port: TCP_PORT });
  });
}

function init() {
  ensureDir(LOG_DIR);
  ensureDir(RECORDINGS_DIR);
  ensureDir(PUBLIC_DIR);

  startTcpServer();
  startHttpServer();

  setInterval(pruneExpiredPendingSessions, 5000);
}

const appStartTime = Date.now();

if (require.main === module) {
  init();
}

module.exports = {
  getStatus,
  acceptSession,
  rejectSocket,
  stopSocket,
  updateStrength,
  init,
};
