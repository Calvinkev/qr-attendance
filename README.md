# QR Attendance System

Zero-database QR code attendance tracker. Create a session, project/share the
QR code, students scan it with their phone camera and type their name + reg
number to check in. Duplicate check-ins are blocked automatically.

## Run it locally (fastest option for tomorrow)

```bash
npm install
npm start
```

Then open **http://localhost:3000/admin.html** on your laptop.

To let phones on the same WiFi scan it, share your laptop's local IP instead
of localhost, e.g. `http://192.168.1.5:3000/admin.html` (find your IP with
`ip addr` or `ifconfig`). The QR code auto-adapts to whatever host you open
the admin page from — no config needed.

### If people are NOT on the same WiFi
Use a quick tunnel so any phone (mobile data included) can reach it:
```bash
npx ngrok http 3000
```
Then open the ngrok URL's `/admin.html` in your browser — the QR it
generates will use that public ngrok link automatically.

## Deploy properly (Render, free tier)
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install`  |  Start command: `npm start`
4. Once live, open `https://your-app.onrender.com/admin.html`

## How it works
- **Admin** (`/admin.html`): create a session (title + duration), get a QR
  code + shareable link, watch check-ins arrive live, export CSV.
- **Student** (`/checkin.html?id=...`): opened by scanning the QR. Enter
  name + registration number → marked present. A second scan/entry with the
  same reg number is rejected as a duplicate.
- Data is stored in `data.json` (auto-created on first run) — no database
  setup needed. Good for one-off sessions; swap in a real DB later if you
  need permanent multi-device storage.

## Tested
Session creation, QR generation, check-in, duplicate-checkin blocking (409),
CSV export, and both pages all verified working end-to-end before delivery.

## Ideas to harden later
- Add an admin password (currently `/admin.html` is open to anyone with the link).
- Rotate the QR every 30s so a screenshot can't be shared/reused.
- Add a geolocation check to block remote/off-site check-ins.
