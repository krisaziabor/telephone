/* ── TELEPHONE client.js ── */

const socket = io();

let myRole = null;        // 'host' | 'participant'
let watchId = null;       // geolocation watch handle
let lastAccuracy = null;

function markerHsl(colorIndex) {
  return `hsl(${(colorIndex * 67 + 195) % 360}, 100%, 65%)`;
}

// ── VIEW MANAGEMENT ──────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

// ── ENTRY ────────────────────────────────────────────────────────
document.getElementById('btn-host').addEventListener('click', () => {
  myRole = 'host';
  socket.emit('set_role', { role: 'host' });
});

document.getElementById('btn-join').addEventListener('click', () => {
  myRole = 'participant';
  socket.emit('set_role', { role: 'participant' });
});

// ── HOST SETUP ───────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  const text = document.getElementById('message-input').value.trim();
  if (!text) return;
  socket.emit('set_message', { text });
  // Also start watching host's own location
  startGeolocation();
  showView('view-host-display');
});

// ── ROLE CONFIRMED ───────────────────────────────────────────────
socket.on('role_confirmed', ({ role }) => {
  if (role === 'host') {
    showView('view-host-setup');
    // Host starts location tracking even before session so coords are ready
    startGeolocation();
  } else {
    showView('view-participant');
    startGeolocation();
  }
});

socket.on('error_msg', (msg) => {
  document.getElementById('error-text').textContent = msg;
  showView('view-error');
});

socket.on('session_ended', () => {
  showView('view-ended');
  stopGeolocation();
});

socket.on('your_marker', ({ colorIndex }) => {
  if (myRole !== 'participant') return;
  const swatch = document.getElementById('participant-color-swatch');
  const label = document.getElementById('participant-color-label');
  const row = document.getElementById('participant-marker-row');
  if (swatch) swatch.style.background = markerHsl(colorIndex);
  if (label) label.textContent = 'your dot on the host map';
  if (row) row.hidden = false;
});

// ── GEOLOCATION ──────────────────────────────────────────────────
function startGeolocation() {
  if (!('geolocation' in navigator)) {
    handleGeoUnavailable('Geolocation API not available in this browser.');
    return;
  }

  const options = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0,
  };

  watchId = navigator.geolocation.watchPosition(
    onGeoSuccess,
    onGeoError,
    options
  );
}

function stopGeolocation() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function onGeoSuccess(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  lastAccuracy = accuracy;
  socket.emit('location_update', { lat, lng, accuracy });

  if (myRole === 'participant') {
    const accEl = document.getElementById('accuracy-display');
    if (accEl) accEl.textContent = `accuracy: ±${Math.round(accuracy)}m`;

    const statusEl = document.getElementById('geo-status');
    if (statusEl) statusEl.textContent = 'location active';
  }
}

function onGeoError(err) {
  socket.emit('location_unavailable');
  const msg = geoErrorMessage(err);
  if (myRole === 'participant') {
    const statusEl = document.getElementById('geo-status');
    if (statusEl) statusEl.textContent = msg;
    const accEl = document.getElementById('accuracy-display');
    if (accEl) accEl.textContent = '';
  }
  console.warn('Geolocation error:', err.code, err.message);
}

function handleGeoUnavailable(reason) {
  socket.emit('location_unavailable');
  if (myRole === 'participant') {
    const statusEl = document.getElementById('geo-status');
    if (statusEl) statusEl.textContent = reason;
  }
  console.warn(reason);
}

function geoErrorMessage(err) {
  switch (err.code) {
    case 1:
      return 'location permission denied — your position is excluded';
    case 2:
      return 'location unavailable — check network or browser settings';
    case 3:
      return 'location request timed out — retrying...';
    default:
      return 'location error';
  }
}

// ── MESSAGE UPDATES ──────────────────────────────────────────────
socket.on('message_update', ({ text, ratio, participantCount, note }) => {
  if (myRole === 'participant') {
    updateParticipantView(text, ratio);
  } else if (myRole === 'host') {
    updateHostStats(text, ratio, participantCount, note);
  }
});

// ── PARTICIPANT VIEW ──────────────────────────────────────────────
function updateParticipantView(text, ratio) {
  const msgEl = document.getElementById('participant-message');
  if (!msgEl) return;

  // Wrap each character in a span for per-char animation
  const html = text
    .split('')
    .map((char, i) => {
      const safe = char === ' ' ? '&nbsp;' : escapeHtml(char);
      return `<span class="char" style="--i:${i}">${safe}</span>`;
    })
    .join('');
  msgEl.innerHTML = html;

  // Glitching class for CSS animation
  if (ratio > 0.4) {
    msgEl.classList.add('glitching');
  } else {
    msgEl.classList.remove('glitching');
  }

  // Background color shift based on ratio
  const body = document.getElementById('view-participant');
  body.classList.remove('bg-calm', 'bg-low', 'bg-mid', 'bg-high', 'bg-chaos');
  if (ratio < 0.1) body.classList.add('bg-calm');
  else if (ratio < 0.3) body.classList.add('bg-low');
  else if (ratio < 0.55) body.classList.add('bg-mid');
  else if (ratio < 0.8) body.classList.add('bg-high');
  else body.classList.add('bg-chaos');

  // Text color shift
  const hue = Math.round(ratio * 330); // 0=white, 330=deep red/magenta
  const sat = Math.round(ratio * 100);
  const light = Math.round(95 - ratio * 55);
  msgEl.style.color = ratio < 0.05
    ? '#FEAE00'
    : `hsl(${hue}, ${sat}%, ${light}%)`;
}

// ── HOST DISPLAY ──────────────────────────────────────────────────
function updateHostStats(text, ratio, participantCount, note) {
  const statP = document.getElementById('stat-participants');
  const statR = document.getElementById('stat-ratio');
  const preview = document.getElementById('host-message-preview');

  if (statP) statP.textContent = `${participantCount} participant${participantCount === 1 ? '' : 's'}`;
  if (statR) statR.textContent = `scramble: ${Math.round(ratio * 100)}%`;
  if (preview) preview.textContent = text;

  if (note) console.log('[NOTE]', note);
}

// ── POSITION MAP (host only) ──────────────────────────────────────
socket.on('position_map', ({ participants, ratio }) => {
  drawMap(participants, ratio);
});

function drawMap(participants, ratio) {
  const canvas = document.getElementById('position-map');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = '#0f0f0f';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 30) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y <= H; y += 30) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  if (participants.length === 0) {
    ctx.fillStyle = '#333';
    ctx.font = '11px Space Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('no participants yet', cx, cy);
  } else {
    // Scale to fit all points
    const xs = participants.map((p) => p.dx);
    const ys = participants.map((p) => p.dy);
    const maxR = Math.max(
      10,
      ...xs.map(Math.abs),
      ...ys.map(Math.abs)
    );
    const scale = (cx * 0.8) / maxR;

    // Draw participant dots (colorIndex matches participant swatches)
    participants.forEach((p, i) => {
      const sx = cx + p.dx * scale;
      const sy = cy - p.dy * scale; // flip y (screen coords)
      const ci = p.colorIndex != null ? p.colorIndex : i;

      // Accuracy circle (faint)
      if (p.accuracy && p.accuracy * scale > 4) {
        ctx.beginPath();
        ctx.arc(sx, sy, p.accuracy * scale, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,170,255,0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Dot
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fillStyle = markerHsl(ci);
      ctx.fill();
    });
  }

  // Host dot (center)
  ctx.beginPath();
  ctx.arc(cx, cy, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#a6ff00';
  ctx.fill();
  ctx.font = '9px Space Mono, monospace';
  ctx.fillStyle = '#a6ff00';
  ctx.textAlign = 'center';
  ctx.fillText('HOST', cx, cy + 18);
}

// ── UTILS ────────────────────────────────────────────────────────
function escapeHtml(char) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return map[char] || char;
}
