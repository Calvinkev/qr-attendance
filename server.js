const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// SSE clients
let sseClients = {};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database helpers ──────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ sessions: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const reqHost = req.get('host');

  // If accessed via localhost/127.0.0.1, swap in the LAN IP so QR codes work on phones
  if (reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1')) {
    const port = reqHost.split(':')[1] || PORT;
    return `${protocol}://${getLocalIP()}:${port}`;
  }
  return `${protocol}://${reqHost}`;
}

// ── SSE broadcast ─────────────────────────────────────────────────
function broadcast(sessionId, event, data) {
  const clients = sseClients[sessionId] || [];
  clients.forEach(res => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

// Admin PIN validation
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid PIN' });
  }
});

// Create a new session
app.post('/api/sessions', async (req, res) => {
  const { title, durationMinutes, pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Session title is required' });
  }

  const db = loadDB();
  const id = crypto.randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const duration = durationMinutes && durationMinutes > 0 ? Number(durationMinutes) : 120;
  const expiresAt = createdAt + duration * 60 * 1000;

  db.sessions[id] = {
    id,
    title: title.trim(),
    createdAt,
    expiresAt,
    durationMinutes: duration,
    attendance: []
  };
  saveDB(db);

  const checkinUrl = `${getBaseUrl(req)}/checkin.html?id=${id}`;
  const qrDataUrl = await qrcode.toDataURL(checkinUrl, { width: 400, margin: 2 });

  res.json({ id, title: db.sessions[id].title, checkinUrl, qrDataUrl, expiresAt, createdAt, durationMinutes: duration });
});

// List all sessions (most recent first)
app.get('/api/sessions', (req, res) => {
  const db = loadDB();
  const list = Object.values(db.sessions)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(s => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      durationMinutes: s.durationMinutes || 120,
      count: s.attendance.length
    }));
  res.json(list);
});

// Get a single session with full attendance list
app.get('/api/sessions/:id', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Delete a session
app.delete('/api/sessions/:id', (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });

  const db = loadDB();
  if (!db.sessions[req.params.id]) return res.status(404).json({ error: 'Session not found' });
  delete db.sessions[req.params.id];
  saveDB(db);
  res.json({ success: true });
});

// Extend session duration
app.patch('/api/sessions/:id/extend', (req, res) => {
  const { pin, additionalMinutes } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });

  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const extra = additionalMinutes && additionalMinutes > 0 ? Number(additionalMinutes) : 30;
  session.expiresAt += extra * 60 * 1000;
  saveDB(db);

  broadcast(req.params.id, 'extended', { expiresAt: session.expiresAt });
  res.json({ success: true, expiresAt: session.expiresAt });
});

// Close session immediately
app.patch('/api/sessions/:id/close', (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });

  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.expiresAt = Date.now();
  saveDB(db);

  broadcast(req.params.id, 'closed', { expiresAt: session.expiresAt });
  res.json({ success: true });
});

// Get/regenerate the QR + checkin link for a session (host-aware)
app.get('/api/sessions/:id/qr', async (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const checkinUrl = `${getBaseUrl(req)}/checkin.html?id=${session.id}`;
  const qrDataUrl = await qrcode.toDataURL(checkinUrl, { width: 400, margin: 2 });
  res.json({ checkinUrl, qrDataUrl });
});

// SSE: live attendance stream
app.get('/api/sessions/:id/stream', (req, res) => {
  const sessionId = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n');

  if (!sseClients[sessionId]) sseClients[sessionId] = [];
  sseClients[sessionId].push(res);

  req.on('close', () => {
    sseClients[sessionId] = (sseClients[sessionId] || []).filter(c => c !== res);
  });
});

// Student check-in
app.post('/api/checkin/:id', (req, res) => {
  const { name, regNumber } = req.body;
  if (!name || !name.trim() || !regNumber || !regNumber.trim()) {
    return res.status(400).json({ error: 'Name and registration number are required' });
  }

  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (Date.now() > session.expiresAt) {
    return res.status(410).json({ error: 'This attendance session has closed.' });
  }

  const normalizedReg = regNumber.trim().toLowerCase();
  const already = session.attendance.find(
    a => a.regNumber.trim().toLowerCase() === normalizedReg
  );
  if (already) {
    return res.status(409).json({
      error: `${already.name}, you're already checked in for this session.`
    });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  const entry = {
    name: name.trim(),
    regNumber: regNumber.trim(),
    timestamp: Date.now(),
    ip
  };

  session.attendance.push(entry);
  saveDB(db);

  // Broadcast to admin SSE clients
  broadcast(req.params.id, 'checkin', {
    name: entry.name,
    regNumber: entry.regNumber,
    timestamp: entry.timestamp,
    count: session.attendance.length
  });

  res.json({ success: true, message: `Welcome ${name.trim()}, you're marked present!` });
});

// CSV export
app.get('/api/sessions/:id/export', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  let csv = 'No.,Name,Registration Number,Time\n';
  session.attendance
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach((a, i) => {
      const time = new Date(a.timestamp).toLocaleString();
      csv += `${i + 1},"${a.name.replace(/"/g, '""')}","${a.regNumber.replace(/"/g, '""')}","${time}"\n`;
    });

  const safeTitle = session.title.replace(/[^a-z0-9]/gi, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${safeTitle}.csv"`);
  res.send(csv);
});

// Dashboard stats
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  const sessions = Object.values(db.sessions);
  const now = Date.now();
  const totalSessions = sessions.length;
  const activeSessions = sessions.filter(s => now < s.expiresAt).length;
  const totalCheckins = sessions.reduce((sum, s) => sum + s.attendance.length, 0);
  const todaySessions = sessions.filter(s => {
    const d = new Date(s.createdAt);
    const t = new Date();
    return d.toDateString() === t.toDateString();
  }).length;

  res.json({ totalSessions, activeSessions, totalCheckins, todaySessions });
});

// Network info for admin UI
app.get('/api/network-info', (req, res) => {
  const localIP = getLocalIP();
  res.json({
    localIP,
    lanUrl: `http://${localIP}:${PORT}`,
    adminUrl: `http://${localIP}:${PORT}/admin.html`
  });
});

app.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`\n  ┌──────────────────────────────────────────────┐`);
  console.log(`  │  QR Attendance System                         │`);
  console.log(`  │  Local:   http://localhost:${PORT}               │`);
  console.log(`  │  Network: http://${localIP}:${PORT}    │`);
  console.log(`  │  Admin PIN: ${ADMIN_PIN}                           │`);
  console.log(`  │                                                │`);
  console.log(`  │  ⚠  Open admin using the Network URL so       │`);
  console.log(`  │     QR codes work for phones on your WiFi!     │`);
  console.log(`  └──────────────────────────────────────────────┘\n`);
});
