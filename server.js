const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ── Helpers ───────────────────────────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const QR_ROTATE_INTERVAL = 30; // seconds

// Rotating QR tokens: sessionId -> { token, expiresAt }
let qrTokens = {};
let sseClients = {};

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { sessions: {}, courses: {}, students: {} };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (!db.courses) db.courses = {};
  if (!db.students) db.students = {};
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const reqHost = req.get('host');
  if (reqHost.startsWith('localhost') || reqHost.startsWith('127.0.0.1')) {
    const port = reqHost.split(':')[1] || PORT;
    return `${protocol}://${getLocalIP()}:${port}`;
  }
  return `${protocol}://${reqHost}`;
}

// ── Rotating QR Token ─────────────────────────────────────────────
function generateQRToken(sessionId) {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + QR_ROTATE_INTERVAL * 1000;
  qrTokens[sessionId] = { token, expiresAt };
  return token;
}

function isValidToken(sessionId, token) {
  const t = qrTokens[sessionId];
  if (!t) return false;
  // Allow current token + give 10s grace for slow networks
  return t.token === token && Date.now() < t.expiresAt + 10000;
}

// ── SSE ───────────────────────────────────────────────────────────
function broadcast(sessionId, event, data) {
  (sseClients[sessionId] || []).forEach(res => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
}

// ── Routes ────────────────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/admin.html'));

// Auth
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (pin === ADMIN_PIN) res.json({ success: true });
  else res.status(401).json({ error: 'Invalid PIN' });
});

// ── Courses ───────────────────────────────────────────────────────
app.get('/api/courses', (req, res) => {
  const db = loadDB();
  res.json(Object.values(db.courses).sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/courses', (req, res) => {
  const { name, code, pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Course name required' });

  const db = loadDB();
  const id = crypto.randomUUID().slice(0, 8);
  db.courses[id] = { id, name: name.trim(), code: (code || '').trim(), createdAt: Date.now() };
  saveDB(db);
  res.json(db.courses[id]);
});

app.delete('/api/courses/:id', (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  const db = loadDB();
  delete db.courses[req.params.id];
  saveDB(db);
  res.json({ success: true });
});

// ── Students (class list) ─────────────────────────────────────────
app.get('/api/students', (req, res) => {
  const db = loadDB();
  const courseId = req.query.courseId;
  let list = Object.values(db.students);
  if (courseId) list = list.filter(s => s.courseId === courseId);
  res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/students', (req, res) => {
  const { name, regNumber, courseId, pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  if (!name || !regNumber) return res.status(400).json({ error: 'Name and reg number required' });

  const db = loadDB();
  const id = crypto.randomUUID().slice(0, 8);
  db.students[id] = { id, name: name.trim(), regNumber: regNumber.trim(), courseId: courseId || null };
  saveDB(db);
  res.json(db.students[id]);
});

app.post('/api/students/bulk', (req, res) => {
  const { students, courseId, pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  if (!Array.isArray(students)) return res.status(400).json({ error: 'Students array required' });

  const db = loadDB();
  let count = 0;
  students.forEach(s => {
    if (s.name && s.regNumber) {
      const id = crypto.randomUUID().slice(0, 8);
      db.students[id] = { id, name: s.name.trim(), regNumber: s.regNumber.trim(), courseId: courseId || null };
      count++;
    }
  });
  saveDB(db);
  res.json({ success: true, imported: count });
});

app.delete('/api/students/:id', (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  const db = loadDB();
  delete db.students[req.params.id];
  saveDB(db);
  res.json({ success: true });
});

// ── Sessions ──────────────────────────────────────────────────────
app.post('/api/sessions', async (req, res) => {
  const { title, durationMinutes, pin, courseId, geoLat, geoLng, geoRadius } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  if (!title || !title.trim()) return res.status(400).json({ error: 'Session title is required' });

  const db = loadDB();
  const id = crypto.randomUUID().slice(0, 8);
  const createdAt = Date.now();
  const duration = durationMinutes && durationMinutes > 0 ? Number(durationMinutes) : 120;
  const expiresAt = createdAt + duration * 60 * 1000;

  db.sessions[id] = {
    id, title: title.trim(), createdAt, expiresAt, durationMinutes: duration,
    courseId: courseId || null,
    geo: geoLat && geoLng ? { lat: Number(geoLat), lng: Number(geoLng), radius: Number(geoRadius) || 100 } : null,
    attendance: []
  };
  saveDB(db);

  // Generate first rotating token
  const token = generateQRToken(id);
  const checkinUrl = `${getBaseUrl(req)}/checkin.html?id=${id}&t=${token}`;
  const qrDataUrl = await qrcode.toDataURL(checkinUrl, { width: 400, margin: 2 });

  res.json({ id, title: db.sessions[id].title, checkinUrl, qrDataUrl, expiresAt, createdAt, durationMinutes: duration, token });
});

app.get('/api/sessions', (req, res) => {
  const db = loadDB();
  const courseId = req.query.courseId;
  let list = Object.values(db.sessions).sort((a, b) => b.createdAt - a.createdAt);
  if (courseId) list = list.filter(s => s.courseId === courseId);
  res.json(list.map(s => ({
    id: s.id, title: s.title, createdAt: s.createdAt, expiresAt: s.expiresAt,
    durationMinutes: s.durationMinutes || 120, count: s.attendance.length,
    courseId: s.courseId, hasGeo: !!s.geo
  })));
});

app.get('/api/sessions/:id', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

app.delete('/api/sessions/:id', (req, res) => {
  const { pin } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  const db = loadDB();
  if (!db.sessions[req.params.id]) return res.status(404).json({ error: 'Session not found' });
  delete db.sessions[req.params.id];
  saveDB(db);
  res.json({ success: true });
});

app.patch('/api/sessions/:id/extend', (req, res) => {
  const { pin, additionalMinutes } = req.body;
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Invalid admin PIN' });
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.expiresAt += (Number(additionalMinutes) || 30) * 60 * 1000;
  saveDB(db);
  broadcast(req.params.id, 'extended', { expiresAt: session.expiresAt });
  res.json({ success: true, expiresAt: session.expiresAt });
});

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

// ── Rotating QR endpoint ──────────────────────────────────────────
app.get('/api/sessions/:id/qr', async (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const token = generateQRToken(session.id);
  const checkinUrl = `${getBaseUrl(req)}/checkin.html?id=${session.id}&t=${token}`;
  const qrDataUrl = await qrcode.toDataURL(checkinUrl, { width: 400, margin: 2 });
  res.json({ checkinUrl, qrDataUrl, token, rotateIn: QR_ROTATE_INTERVAL });
});

// SSE stream
app.get('/api/sessions/:id/stream', (req, res) => {
  const sessionId = req.params.id;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('\n');
  if (!sseClients[sessionId]) sseClients[sessionId] = [];
  sseClients[sessionId].push(res);
  req.on('close', () => {
    sseClients[sessionId] = (sseClients[sessionId] || []).filter(c => c !== res);
  });
});

// ── Check-in (with rotating token + device fingerprint + geolocation) ──
app.post('/api/checkin/:id', (req, res) => {
  const { name, regNumber, token, deviceId, geoLat, geoLng } = req.body;
  if (!name || !name.trim() || !regNumber || !regNumber.trim()) {
    return res.status(400).json({ error: 'Name and registration number are required' });
  }

  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  if (Date.now() > session.expiresAt) {
    return res.status(410).json({ error: 'This attendance session has closed.' });
  }

  // Validate rotating token
  if (token && !isValidToken(req.params.id, token)) {
    return res.status(403).json({ error: 'QR code expired. Please scan the latest QR code shown on screen.' });
  }

  // Duplicate reg number check
  const normalizedReg = regNumber.trim().toLowerCase();
  const already = session.attendance.find(a => a.regNumber.trim().toLowerCase() === normalizedReg);
  if (already) {
    return res.status(409).json({ error: `${already.name}, you're already checked in.` });
  }

  // Device fingerprint check
  if (deviceId) {
    const sameDevice = session.attendance.find(a => a.deviceId && a.deviceId === deviceId);
    if (sameDevice) {
      return res.status(409).json({ error: `This device was already used to check in by ${sameDevice.name}.` });
    }
  }

  // Geolocation check
  if (session.geo && geoLat && geoLng) {
    const dist = haversine(session.geo.lat, session.geo.lng, Number(geoLat), Number(geoLng));
    if (dist > session.geo.radius) {
      return res.status(403).json({ error: `You appear to be ${Math.round(dist)}m away. You must be within ${session.geo.radius}m to check in.` });
    }
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const entry = {
    name: name.trim(), regNumber: regNumber.trim(), timestamp: Date.now(),
    ip, deviceId: deviceId || null,
    geo: geoLat && geoLng ? { lat: Number(geoLat), lng: Number(geoLng) } : null
  };

  session.attendance.push(entry);
  saveDB(db);

  broadcast(req.params.id, 'checkin', {
    name: entry.name, regNumber: entry.regNumber, timestamp: entry.timestamp,
    count: session.attendance.length
  });

  res.json({ success: true, message: `Welcome ${name.trim()}, you're marked present!` });
});

// ── Haversine distance (meters) ───────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── CSV export ────────────────────────────────────────────────────
app.get('/api/sessions/:id/export', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  // If course has registered students, show present/absent
  const registered = Object.values(db.students).filter(s => s.courseId === session.courseId);
  const attendedRegs = new Set(session.attendance.map(a => a.regNumber.trim().toLowerCase()));

  let csv = 'No.,Name,Registration Number,Status,Time\n';
  if (registered.length > 0) {
    registered.sort((a, b) => a.name.localeCompare(b.name)).forEach((s, i) => {
      const attended = session.attendance.find(a => a.regNumber.trim().toLowerCase() === s.regNumber.trim().toLowerCase());
      const status = attended ? 'Present' : 'Absent';
      const time = attended ? new Date(attended.timestamp).toLocaleString() : '';
      csv += `${i+1},"${s.name}","${s.regNumber}","${status}","${time}"\n`;
    });
    // Also add walk-ins not in the class list
    session.attendance.filter(a => !registered.find(s => s.regNumber.trim().toLowerCase() === a.regNumber.trim().toLowerCase()))
      .forEach((a, i) => {
        csv += `${registered.length+i+1},"${a.name}","${a.regNumber}","Present (Walk-in)","${new Date(a.timestamp).toLocaleString()}"\n`;
      });
  } else {
    session.attendance.sort((a, b) => a.timestamp - b.timestamp).forEach((a, i) => {
      csv += `${i+1},"${a.name.replace(/"/g,'""')}","${a.regNumber.replace(/"/g,'""')}","Present","${new Date(a.timestamp).toLocaleString()}"\n`;
    });
  }

  const safeTitle = session.title.replace(/[^a-z0-9]/gi, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${safeTitle}.csv"`);
  res.send(csv);
});

// ── Reports / Analytics ───────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  const sessions = Object.values(db.sessions);
  const now = Date.now();
  res.json({
    totalSessions: sessions.length,
    activeSessions: sessions.filter(s => now < s.expiresAt).length,
    totalCheckins: sessions.reduce((sum, s) => sum + s.attendance.length, 0),
    todaySessions: sessions.filter(s => new Date(s.createdAt).toDateString() === new Date().toDateString()).length,
    totalStudents: Object.keys(db.students).length,
    totalCourses: Object.keys(db.courses).length
  });
});

app.get('/api/reports/student/:regNumber', (req, res) => {
  const db = loadDB();
  const reg = req.params.regNumber.trim().toLowerCase();
  const sessions = Object.values(db.sessions);
  const attended = sessions.filter(s => s.attendance.some(a => a.regNumber.trim().toLowerCase() === reg));
  res.json({
    regNumber: req.params.regNumber,
    totalSessions: sessions.length,
    attended: attended.length,
    rate: sessions.length ? Math.round((attended.length / sessions.length) * 100) : 0,
    sessions: attended.map(s => ({ id: s.id, title: s.title, date: s.createdAt }))
  });
});

app.get('/api/reports/course/:courseId', (req, res) => {
  const db = loadDB();
  const sessions = Object.values(db.sessions).filter(s => s.courseId === req.params.courseId);
  const students = Object.values(db.students).filter(s => s.courseId === req.params.courseId);

  const studentStats = students.map(st => {
    const attended = sessions.filter(s => s.attendance.some(a => a.regNumber.trim().toLowerCase() === st.regNumber.trim().toLowerCase()));
    return {
      name: st.name, regNumber: st.regNumber,
      attended: attended.length, total: sessions.length,
      rate: sessions.length ? Math.round((attended.length / sessions.length) * 100) : 0
    };
  });

  res.json({
    courseId: req.params.courseId,
    course: db.courses[req.params.courseId],
    totalSessions: sessions.length,
    students: studentStats.sort((a, b) => b.rate - a.rate)
  });
});

// Network info
app.get('/api/network-info', (req, res) => {
  const localIP = getLocalIP();
  res.json({ localIP, lanUrl: `http://${localIP}:${PORT}`, adminUrl: `http://${localIP}:${PORT}/admin.html` });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log(`\n  ┌──────────────────────────────────────────────┐`);
  console.log(`  │  QR Attendance System v2.0                    │`);
  console.log(`  │  Local:   http://localhost:${PORT}               │`);
  console.log(`  │  Network: http://${localIP}:${PORT}          │`);
  console.log(`  │  Admin PIN: ${ADMIN_PIN}                           │`);
  console.log(`  │  QR Rotation: every ${QR_ROTATE_INTERVAL}s                    │`);
  console.log(`  └──────────────────────────────────────────────┘\n`);
});
