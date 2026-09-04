const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.redirect('/admin.html');
});

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
  const host = req.get('host');
  return `${protocol}://${host}`;
}

// Create a new session
app.post('/api/sessions', async (req, res) => {
  const { title, durationMinutes } = req.body;
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
    attendance: []
  };
  saveDB(db);

  const checkinUrl = `${getBaseUrl(req)}/checkin.html?id=${id}`;
  const qrDataUrl = await qrcode.toDataURL(checkinUrl, { width: 400, margin: 2 });

  res.json({ id, title: db.sessions[id].title, checkinUrl, qrDataUrl, expiresAt, createdAt });
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

// Get/regenerate the QR + checkin link for a session (host-aware)
app.get('/api/sessions/:id/qr', async (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const checkinUrl = `${getBaseUrl(req)}/checkin.html?id=${session.id}`;
  const qrDataUrl = await qrcode.toDataURL(checkinUrl, { width: 400, margin: 2 });
  res.json({ checkinUrl, qrDataUrl });
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

  session.attendance.push({
    name: name.trim(),
    regNumber: regNumber.trim(),
    timestamp: Date.now(),
    ip
  });
  saveDB(db);

  res.json({ success: true, message: `Welcome ${name.trim()}, you're marked present!` });
});

// CSV export
app.get('/api/sessions/:id/export', (req, res) => {
  const db = loadDB();
  const session = db.sessions[req.params.id];
  if (!session) return res.status(404).json({ error: 'Session not found' });

  let csv = 'Name,Registration Number,Time\n';
  session.attendance
    .sort((a, b) => a.timestamp - b.timestamp)
    .forEach(a => {
      const time = new Date(a.timestamp).toLocaleString();
      csv += `"${a.name.replace(/"/g, '""')}","${a.regNumber.replace(/"/g, '""')}","${time}"\n`;
    });

  const safeTitle = session.title.replace(/[^a-z0-9]/gi, '_');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${safeTitle}.csv"`);
  res.send(csv);
});

app.listen(PORT, () => {
  console.log(`QR Attendance server running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
});
