let adminPin = null, currentId = null, sseSource = null, timerInterval = null, qrRotateInterval = null;
let currentSession = null, allAttendees = [], audioCtx = null;

// ── Audio ─────────────────────────────────────────────────────
function playChime() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    o.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.1);
    g.gain.setValueAtTime(0.25, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.4);
    o.start(); o.stop(audioCtx.currentTime + 0.4);
  } catch(e) {}
}

// ── Tabs ──────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  if (tab === 'dashboard') { document.getElementById('tabDashboard').style.display = 'block'; document.getElementById('tabDash').classList.add('active'); }
  else if (tab === 'courses') { document.getElementById('tabCourses').style.display = 'block'; document.getElementById('tabCourses').classList.add('active'); loadCourses(); loadStudents(); }
  else if (tab === 'reports') { document.getElementById('tabReportContent').style.display = 'block'; document.getElementById('tabReports').classList.add('active'); loadCourseDropdowns(); }
}

// ── Auth ──────────────────────────────────────────────────────
function authenticate() {
  const pin = document.getElementById('pinInput').value;
  if (!pin) return;
  fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) })
    .then(r => r.json()).then(data => {
      if (data.success) {
        adminPin = pin; sessionStorage.setItem('pin', pin);
        document.getElementById('pinGate').classList.add('hidden');
        document.getElementById('app').style.display = 'block';
        loadStats(); loadHistory(); loadCourseDropdowns(); checkNetwork();
      } else {
        document.getElementById('pinError').textContent = 'Wrong PIN.';
        document.getElementById('pinInput').value = '';
      }
    });
}
document.getElementById('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') authenticate(); });

function logout() {
  adminPin = null; sessionStorage.removeItem('pin');
  document.getElementById('pinGate').classList.remove('hidden');
  document.getElementById('app').style.display = 'none';
  goHome();
}

(function() { const s = sessionStorage.getItem('pin'); if (s) { document.getElementById('pinInput').value = s; authenticate(); } })();

// ── Network Check ─────────────────────────────────────────────
async function checkNetwork() {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    try {
      const res = await fetch('/api/network-info'); const info = await res.json();
      document.getElementById('networkUrl').href = info.adminUrl;
      document.getElementById('networkUrl').textContent = info.adminUrl;
      document.getElementById('networkBanner').style.display = 'block';
    } catch(e) {}
  }
}

// ── Toast ─────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 3500);
}

// ── Stats ─────────────────────────────────────────────────────
async function loadStats() {
  const s = await (await fetch('/api/stats')).json();
  ['statTotal','statActive','statCheckins','statToday'].forEach((id, i) => {
    const vals = [s.totalSessions, s.activeSessions, s.totalCheckins, s.todaySessions];
    document.getElementById(id).textContent = vals[i];
  });
}

// ── Geo toggle ────────────────────────────────────────────────
document.getElementById('enableGeo').addEventListener('change', function() {
  document.getElementById('geoFields').style.display = this.checked ? 'flex' : 'none';
});

function captureMyLocation() {
  if (!navigator.geolocation) { showToast('Geolocation not supported', 'error'); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('geoLat').value = pos.coords.latitude;
    document.getElementById('geoLng').value = pos.coords.longitude;
    showToast('Location captured!', 'success');
  }, () => showToast('Could not get location', 'error'), { enableHighAccuracy: true });
}

// ── Create Session ────────────────────────────────────────────
async function createSession() {
  const title = document.getElementById('title').value.trim();
  if (!title) { showToast('Enter a session title', 'error'); return; }
  const body = {
    title, durationMinutes: document.getElementById('duration').value, pin: adminPin,
    courseId: document.getElementById('sessionCourse').value || null
  };
  if (document.getElementById('enableGeo').checked) {
    body.geoLat = document.getElementById('geoLat').value;
    body.geoLng = document.getElementById('geoLng').value;
    body.geoRadius = document.getElementById('geoRadius').value;
    if (!body.geoLat || !body.geoLng) { showToast('Capture your location first', 'error'); return; }
  }
  const res = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { showToast(data.error, 'error'); return; }
  showToast('Session created!', 'success');
  openSession(data); loadHistory(); loadStats();
}

// ── Open Session ──────────────────────────────────────────────
function openSession(data) {
  currentId = data.id; currentSession = data;
  document.getElementById('createCard').style.display = 'none';
  document.getElementById('activeCard').style.display = 'block';
  document.getElementById('activeTitle').textContent = data.title;
  document.getElementById('qrImg').src = data.qrDataUrl || '';
  document.getElementById('linkBox').textContent = data.checkinUrl || '';
  refreshAttendance(); startTimer(data.expiresAt); connectSSE(data.id); startQRRotation();
}

// ── QR Rotation ───────────────────────────────────────────────
function startQRRotation() {
  if (qrRotateInterval) clearInterval(qrRotateInterval);
  qrRotateInterval = setInterval(rotateQR, 30000);
}

async function rotateQR() {
  if (!currentId) return;
  const res = await fetch('/api/sessions/' + currentId + '/qr');
  const data = await res.json();
  if (res.ok) {
    document.getElementById('qrImg').src = data.qrDataUrl;
    document.getElementById('linkBox').textContent = data.checkinUrl;
  }
}

// ── SSE ───────────────────────────────────────────────────────
function connectSSE(id) {
  if (sseSource) sseSource.close();
  sseSource = new EventSource('/api/sessions/' + id + '/stream');
  sseSource.addEventListener('checkin', e => {
    const d = JSON.parse(e.data);
    showToast(`${d.name} checked in!`, 'success');
    playChime(); refreshAttendance(); loadStats();
  });
  sseSource.addEventListener('closed', () => refreshAttendance());
  sseSource.addEventListener('extended', () => refreshAttendance());
}

// ── Timer ─────────────────────────────────────────────────────
function startTimer(expiresAt) {
  if (timerInterval) clearInterval(timerInterval);
  function tick() {
    const rem = expiresAt - Date.now();
    const badge = document.getElementById('statusBadge'), timer = document.getElementById('timerText');
    if (rem <= 0) { badge.textContent = '● CLOSED'; badge.className = 'badge badge-closed'; timer.textContent = 'Expired'; clearInterval(timerInterval); return; }
    badge.textContent = '● LIVE'; badge.className = 'badge badge-live';
    const m = Math.floor(rem / 60000), s = Math.floor((rem % 60000) / 1000);
    timer.textContent = `${m}m ${s < 10 ? '0' : ''}${s}s remaining`;
  }
  tick(); timerInterval = setInterval(tick, 1000);
}

// ── Attendance ────────────────────────────────────────────────
async function refreshAttendance() {
  if (!currentId) return;
  const session = await (await fetch('/api/sessions/' + currentId)).json();
  currentSession = session; allAttendees = session.attendance.slice().reverse();
  document.getElementById('countNum').textContent = session.attendance.length;
  startTimer(session.expiresAt); renderAttendees(allAttendees);
}

function renderAttendees(list) {
  const ul = document.getElementById('attendeeList');
  if (!list.length) { ul.innerHTML = '<li class="empty-state">No check-ins yet</li>'; return; }
  ul.innerHTML = list.map((a, i) => `<li class="attendee-item"><div class="attendee-info">
    <span class="attendee-num">${list.length - i}</span><div>
    <div class="attendee-name">${esc(a.name)}</div><div class="attendee-reg">${esc(a.regNumber)}</div></div></div>
    <div class="attendee-time">${new Date(a.timestamp).toLocaleTimeString()}</div></li>`).join('');
}

function filterAttendees() {
  const q = document.getElementById('searchInput').value.toLowerCase();
  renderAttendees(q ? allAttendees.filter(a => a.name.toLowerCase().includes(q) || a.regNumber.toLowerCase().includes(q)) : allAttendees);
}

// ── Session Actions ───────────────────────────────────────────
async function extendSession() {
  await fetch('/api/sessions/' + currentId + '/extend', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: adminPin, additionalMinutes: 30 }) });
  showToast('Extended by 30 min', 'success'); refreshAttendance();
}
async function closeSession() {
  if (!confirm('Close session now?')) return;
  await fetch('/api/sessions/' + currentId + '/close', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: adminPin }) });
  showToast('Session closed', 'info'); refreshAttendance();
}
async function deleteSession(id) {
  if (!confirm('Delete permanently?')) return;
  await fetch('/api/sessions/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: adminPin }) });
  showToast('Deleted', 'info'); loadHistory(); loadStats(); if (currentId === id) goHome();
}
function exportCsv() { if (currentId) window.location.href = '/api/sessions/' + currentId + '/export'; }
function copyLink() { navigator.clipboard.writeText(document.getElementById('linkBox').textContent).then(() => showToast('Copied!', 'success')); }

function openProjector() {
  if (!currentId) return;
  window.open('/projector.html?id=' + currentId, '_blank', 'width=1200,height=700');
}

function printQR() {
  const img = document.getElementById('qrImg').src;
  const title = document.getElementById('activeTitle').textContent;
  const w = window.open('', '_blank');
  w.document.write(`<html><head><title>Print QR</title><style>body{font-family:Arial;text-align:center;padding:40px}img{width:300px;height:300px}h1{font-size:24px}p{color:#666;font-size:14px}</style></head><body><h1>${esc(title)}</h1><img src="${img}"><p>Scan this QR code to mark your attendance</p><p>${document.getElementById('linkBox').textContent}</p><script>window.print()</script></body></html>`);
}

function goHome() {
  currentId = null; currentSession = null;
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (timerInterval) clearInterval(timerInterval);
  if (qrRotateInterval) clearInterval(qrRotateInterval);
  document.getElementById('createCard').style.display = 'block';
  document.getElementById('activeCard').style.display = 'none';
  document.getElementById('title').value = '';
}

// ── History ───────────────────────────────────────────────────
async function loadHistory() {
  const sessions = await (await fetch('/api/sessions')).json();
  const el = document.getElementById('historyList');
  if (!sessions.length) { el.innerHTML = '<div class="empty-state">No sessions yet</div>'; return; }
  el.innerHTML = sessions.map(s => {
    const live = Date.now() < s.expiresAt;
    const d = new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `<div class="history-item" onclick="loadSessionQr('${s.id}')"><div class="history-left">
      <div class="history-title">${esc(s.title)}${s.hasGeo ? ' 📍' : ''}</div>
      <div class="history-meta">${d} · ${s.count} attendee${s.count !== 1 ? 's' : ''}</div></div>
      <div class="history-right"><span class="badge ${live ? 'badge-live' : 'badge-closed'}">${live ? '● Live' : '● Closed'}</span>
      <button class="btn-delete" onclick="event.stopPropagation();deleteSession('${s.id}')" title="Delete">🗑</button></div></div>`;
  }).join('');
}

async function loadSessionQr(id) {
  const [qr, sess] = await Promise.all([fetch('/api/sessions/' + id + '/qr').then(r => r.json()), fetch('/api/sessions/' + id).then(r => r.json())]);
  openSession({ ...sess, qrDataUrl: qr.qrDataUrl, checkinUrl: qr.checkinUrl });
}

// ── Courses ───────────────────────────────────────────────────
async function loadCourses() {
  const courses = await (await fetch('/api/courses')).json();
  const el = document.getElementById('courseList');
  if (!courses.length) { el.innerHTML = '<div class="empty-state">No courses yet</div>'; return; }
  el.innerHTML = courses.map(c => `<div class="history-item"><div class="history-left">
    <div class="history-title">${esc(c.name)}</div><div class="history-meta">${esc(c.code || 'No code')}</div></div>
    <button class="btn-delete" onclick="deleteCourse('${c.id}')" title="Delete">🗑</button></div>`).join('');
}

async function loadCourseDropdowns() {
  const courses = await (await fetch('/api/courses')).json();
  ['sessionCourse', 'studentCourse', 'reportCourse'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const val = el.value;
    const first = el.options[0].outerHTML;
    el.innerHTML = first + courses.map(c => `<option value="${c.id}">${esc(c.code ? c.code + ' — ' : '')}${esc(c.name)}</option>`).join('');
    el.value = val;
  });
}

async function addCourse() {
  const name = document.getElementById('courseName').value.trim();
  const code = document.getElementById('courseCode').value.trim();
  if (!name) { showToast('Enter course name', 'error'); return; }
  await fetch('/api/courses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code, pin: adminPin }) });
  document.getElementById('courseName').value = ''; document.getElementById('courseCode').value = '';
  showToast('Course added', 'success'); loadCourses(); loadCourseDropdowns();
}

async function deleteCourse(id) {
  if (!confirm('Delete this course?')) return;
  await fetch('/api/courses/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: adminPin }) });
  loadCourses(); loadCourseDropdowns();
}

// ── Students ──────────────────────────────────────────────────
async function loadStudents() {
  const courseId = document.getElementById('studentCourse').value;
  const url = '/api/students' + (courseId ? '?courseId=' + courseId : '');
  const students = await (await fetch(url)).json();
  const el = document.getElementById('studentList');
  if (!students.length) { el.innerHTML = '<div class="empty-state">No students registered</div>'; return; }
  el.innerHTML = students.map(s => `<div class="history-item"><div class="history-left">
    <div class="history-title">${esc(s.name)}</div><div class="history-meta">${esc(s.regNumber)}</div></div>
    <button class="btn-delete" onclick="deleteStudent('${s.id}')" title="Remove">🗑</button></div>`).join('');
}

async function addStudent() {
  const name = document.getElementById('studentName').value.trim();
  const reg = document.getElementById('studentReg').value.trim();
  const courseId = document.getElementById('studentCourse').value;
  if (!name || !reg) { showToast('Enter name and reg number', 'error'); return; }
  await fetch('/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, regNumber: reg, courseId, pin: adminPin }) });
  document.getElementById('studentName').value = ''; document.getElementById('studentReg').value = '';
  showToast('Student added', 'success'); loadStudents();
}

function showBulkImport() { document.getElementById('bulkImportArea').style.display = document.getElementById('bulkImportArea').style.display === 'none' ? 'block' : 'none'; }

async function bulkImport() {
  const csv = document.getElementById('bulkCsv').value.trim();
  const courseId = document.getElementById('studentCourse').value;
  if (!csv) { showToast('Paste CSV data', 'error'); return; }
  const students = csv.split('\n').map(line => {
    const [name, regNumber] = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    return name && regNumber ? { name, regNumber } : null;
  }).filter(Boolean);
  if (!students.length) { showToast('No valid rows found', 'error'); return; }
  const res = await fetch('/api/students/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ students, courseId, pin: adminPin }) });
  const data = await res.json();
  showToast(`Imported ${data.imported} students`, 'success');
  document.getElementById('bulkCsv').value = ''; loadStudents();
}

async function deleteStudent(id) {
  await fetch('/api/students/' + id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: adminPin }) });
  loadStudents();
}

// ── Reports ───────────────────────────────────────────────────
async function loadReport() {
  const courseId = document.getElementById('reportCourse').value;
  const el = document.getElementById('reportContent');
  if (!courseId) { el.innerHTML = ''; return; }
  const res = await fetch('/api/reports/course/' + courseId);
  const data = await res.json();
  if (!data.students.length) { el.innerHTML = '<div class="empty-state">No registered students for this course</div>'; return; }
  el.innerHTML = `<div class="report-summary">Sessions: <strong>${data.totalSessions}</strong> · Students: <strong>${data.students.length}</strong></div>
    <table class="report-table"><thead><tr><th>Name</th><th>Reg Number</th><th>Attended</th><th>Rate</th></tr></thead><tbody>
    ${data.students.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.regNumber)}</td><td>${s.attended}/${s.total}</td>
      <td><div class="rate-bar"><div class="rate-fill" style="width:${s.rate}%;background:${s.rate >= 75 ? 'var(--green)' : s.rate >= 50 ? 'var(--yellow)' : 'var(--red)'}"></div><span>${s.rate}%</span></div></td></tr>`).join('')}
    </tbody></table>`;
}

async function lookupStudent() {
  const reg = document.getElementById('lookupReg').value.trim();
  if (!reg) return;
  const res = await fetch('/api/reports/student/' + encodeURIComponent(reg));
  const data = await res.json();
  const el = document.getElementById('lookupResult');
  el.innerHTML = `<div class="report-summary">Attended <strong>${data.attended}</strong> of <strong>${data.totalSessions}</strong> sessions (<strong>${data.rate}%</strong>)</div>
    ${data.sessions.length ? data.sessions.map(s => `<div class="history-item"><div class="history-left">
      <div class="history-title">${esc(s.title)}</div><div class="history-meta">${new Date(s.date).toLocaleDateString()}</div></div></div>`).join('') : '<div class="empty-state">No sessions attended</div>'}`;
}

function esc(s) { return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
