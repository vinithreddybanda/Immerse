const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const HTTP_PORT = Number(process.env.HTTP_PORT || 3100);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(__dirname, 'logs');

const sessions = new Map();
const receivers = new Set();
let httpServer = null;
let signalServer = null;
const appStartTime = Date.now();

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function logEvent(level, message, extra = {}) {
  const entry = { timestamp: new Date().toISOString(), level, message, ...extra };
  console.log(`[${entry.timestamp}] ${level.toUpperCase()} ${message}`);
  fs.appendFileSync(path.join(LOG_DIR, 'receiver.log'), `${JSON.stringify(entry)}\n`, 'utf8');
}

function send(socket, message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sessionRecord(session) {
  return {
    id: session.id,
    remoteAddress: session.remoteAddress,
    connectedAt: session.connectedAt,
    status: session.status,
    lastActivity: session.lastActivity,
    reason: session.reason || null,
  };
}

function getStatus() {
  const pending = [];
  const active = [];
  for (const session of sessions.values()) {
    (session.status === 'pending' ? pending : active).push(sessionRecord(session));
  }
  return {
    ok: true,
    server: { httpPort: HTTP_PORT, running: !!httpServer, uptimeMs: Date.now() - appStartTime },
    pending,
    active,
    total: sessions.size,
  };
}

function notifyReceivers(message) {
  for (const receiver of receivers) send(receiver, message);
}

function removeSession(sessionId, reason = 'disconnected') {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.reason = reason;
  session.status = 'stopped';
  send(session.sender, { type: 'session-ended', sessionId, reason });
  send(session.receiver, { type: 'session-ended', sessionId, reason });
  sessions.delete(sessionId);
  notifyReceivers({ type: 'session-removed', sessionId });
  logEvent('info', 'Session removed', { id: sessionId, reason });
}

function relaySignal(session, source, message) {
  const target = source === session.sender ? session.receiver : session.sender;
  send(target, { ...message, sessionId: session.id });
  session.lastActivity = Date.now();
}

function handleSocketMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (error) {
    send(socket, { type: 'error', message: 'Invalid signaling message' });
    return;
  }

  if (message.type === 'hello') {
    if (message.role === 'receiver') {
      receivers.add(socket);
      send(socket, { type: 'ready', role: 'receiver' });
      for (const session of sessions.values()) send(socket, { type: 'session-request', ...sessionRecord(session) });
      return;
    }

    if (message.role === 'sender') {
      const session = {
        id: `session_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        sender: socket,
        receiver: null,
        remoteAddress: socket._socket?.remoteAddress || 'unknown',
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        status: 'pending',
        reason: null,
      };
      socket.sessionId = session.id;
      sessions.set(session.id, session);
      send(socket, { type: 'registered', sessionId: session.id });
      notifyReceivers({ type: 'session-request', ...sessionRecord(session) });
      logEvent('info', 'Mobile sender connected', { id: session.id, remoteAddress: session.remoteAddress });
      return;
    }
  }

  if (message.type === 'accept' || message.type === 'reject' || message.type === 'stop') {
    const session = sessions.get(message.sessionId);
    if (!session || !receivers.has(socket)) return;
    if (message.type === 'accept') {
      session.receiver = socket;
      session.status = 'active';
      session.lastActivity = Date.now();
      send(session.sender, { type: 'accepted', sessionId: session.id });
      send(socket, { type: 'session-accepted', sessionId: session.id });
    } else {
      send(session.sender, { type: 'rejected', sessionId: session.id });
      removeSession(session.id, message.type === 'stop' ? 'stopped_by_admin' : 'rejected_by_admin');
    }
    return;
  }

  if (message.sessionId && ['offer', 'answer', 'candidate'].includes(message.type)) {
    const session = sessions.get(message.sessionId);
    if (session && (socket === session.sender || socket === session.receiver)) relaySignal(session, socket, message);
  }
}

function handleSocketClose(socket) {
  receivers.delete(socket);
  if (socket.sessionId) removeSession(socket.sessionId, 'sender_disconnected');
  for (const session of sessions.values()) {
    if (session.receiver === socket) removeSession(session.id, 'receiver_disconnected');
  }
}

function serveStaticFile(filePath, res) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
    };
    res.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function onHttpRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') return serveStaticFile(path.join(PUBLIC_DIR, 'index.html'), res);
  if (req.method === 'GET' && url.pathname === '/sender') return serveStaticFile(path.join(PUBLIC_DIR, 'sender.html'), res);
  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getStatus()));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
    return serveStaticFile(path.join(PUBLIC_DIR, url.pathname.replace(/^\/public\//, '')), res);
  }
  if (req.method === 'POST' && url.pathname === '/api/decision') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { id, action } = JSON.parse(body || '{}');
        const session = sessions.get(id);
        if (!session || !['accept', 'reject', 'stop'].includes(action)) throw new Error('Invalid session or action');
        send([...receivers][0], { type: action, sessionId: id });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: error.message }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

function init() {
  ensureDir(LOG_DIR);
  ensureDir(PUBLIC_DIR);
  httpServer = http.createServer(onHttpRequest);
  signalServer = new WebSocket.Server({ server: httpServer, path: '/signal' });
  signalServer.on('connection', (socket) => {
    socket.on('message', (message) => handleSocketMessage(socket, message));
    socket.on('close', () => handleSocketClose(socket));
    socket.on('error', (error) => logEvent('warn', 'Signaling socket error', { error: error.message }));
  });
  httpServer.listen(HTTP_PORT, () => logEvent('info', 'WebRTC receiver started', { port: HTTP_PORT }));
}

if (require.main === module) init();

module.exports = { getStatus, init };
