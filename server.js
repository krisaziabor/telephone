const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_PATH = process.env.TLS_KEY || path.join(CERT_DIR, 'key.pem');
const CERT_PATH = process.env.TLS_CERT || path.join(CERT_DIR, 'cert.pem');

function loadTlsOptions() {
  try {
    if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
      return {
        key: fs.readFileSync(KEY_PATH),
        cert: fs.readFileSync(CERT_PATH),
      };
    }
  } catch (_) {
    /* fall through */
  }
  return null;
}

const tlsOptions = loadTlsOptions();
const server = tlsOptions
  ? https.createServer(tlsOptions, app)
  : http.createServer(app);
const io = new Server(server);
const useHttps = Boolean(tlsOptions);

// State
let host = null;         // socket id of the host
let message = null;      // the secret message
const clients = {};      // socketId -> { lat, lng, accuracy, isHost }

// --- Utility: get local IP ---
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// --- Haversine distance in meters ---
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// --- Scramble function ---
// Degradation character pool — signal corruption aesthetic
const GLITCH_CHARS = [
  // Box drawing
  '─','│','┼','┤','├','┬','┴','╋','╠','╣','╦','╩','╔','╗','╚','╝',
  // Math / symbols
  '∅','∆','∇','∞','≈','≠','≡','±','×','÷','∑','∏','√','∫','∂','∈',
  // Misc Latin / punctuation glitch
  'Ä','Ö','Ü','ß','æ','ø','ñ','ç','ý','þ','ð',
  // Braille / block
  '⠿','⠾','⠽','▓','▒','░','█','▄','▀','▌','▐',
  // Currency / arrows
  '¥','€','£','¢','→','←','↑','↓','↔','↕','⇒','⇐','⇔',
];

function randomGlitch() {
  return GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)];
}

function scramble(text, ratio) {
  if (!text) return '';
  if (ratio <= 0) return text;
  if (ratio >= 1) return text.split('').map(() => randomGlitch()).join('');
  return text
    .split('')
    .map((char) => (Math.random() < ratio ? randomGlitch() : char))
    .join('');
}

function sortedParticipantIds() {
  return Object.keys(clients).filter((id) => id !== host).sort();
}

function emitParticipantMarkers() {
  sortedParticipantIds().forEach((id, idx) => {
    io.to(id).emit('your_marker', { colorIndex: idx });
  });
}

// --- Compute scramble ratio and broadcast ---
function broadcast() {
  if (!message || !host || !clients[host]) return;

  const hostClient = clients[host];
  if (!hostClient.lat || !hostClient.lng) {
    // Host has no coords yet
    io.emit('message_update', {
      text: scramble(message, 1),
      ratio: 1,
      participantCount: Object.keys(clients).length - 1,
      note: 'Waiting for host location...',
    });
    return;
  }

  // Collect participants with coords (exclude host)
  const participants = Object.entries(clients)
    .filter(([id, c]) => id !== host && c.lat && c.lng)
    .map(([id, c]) => ({
      id,
      dist: haversine(hostClient.lat, hostClient.lng, c.lat, c.lng),
      accuracy: c.accuracy,
    }));

  const totalConnected = Object.keys(clients).length - 1; // minus host

  let ratio = 1;
  let note = '';

  if (participants.length < 1) {
    ratio = 1;
    note = 'No participants with location yet.';
  } else if (participants.length === 1) {
    ratio = 1;
    note = 'Need at least 2 participants to compute equidistance.';
  } else {
    const distances = participants.map((p) => p.dist);
    const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
    if (mean === 0) {
      ratio = 0;
    } else {
      const variance =
        distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length;
      const stdDev = Math.sqrt(variance);
      const cv = stdDev / mean;
      ratio = Math.min(1, Math.max(0, cv));
    }
  }

  const scramblerText = scramble(message, ratio);

  // Emit to all
  io.emit('message_update', {
    text: scramblerText,
    ratio,
    participantCount: totalConnected,
    note,
  });

  // Emit position map to everyone (relative to host position, in meters)
  if (clients[host] && host) {
    const idOrder = sortedParticipantIds();
    const relativePositions = Object.entries(clients)
      .filter(([id, c]) => id !== host && c.lat && c.lng)
      .map(([id, c]) => {
        // Approximate dx/dy in meters
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dy = R * toRad(c.lat - hostClient.lat);
        const dx = R * Math.cos(toRad(hostClient.lat)) * toRad(c.lng - hostClient.lng);
        const colorIndex = idOrder.indexOf(id);
        return { dx, dy, accuracy: c.accuracy, colorIndex };
      });

    io.emit('position_map', {
      participants: relativePositions,
      ratio,
    });
  }
}

// --- Socket.io ---
io.on('connection', (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);
  clients[socket.id] = {};

  // Client sends its role
  socket.on('set_role', ({ role }) => {
    if (role === 'host') {
      if (host && clients[host]) {
        // Already a host — reject
        socket.emit('error_msg', 'A host already exists in this session.');
        return;
      }
      host = socket.id;
      clients[socket.id].isHost = true;
      socket.emit('role_confirmed', { role: 'host' });
      console.log(`[HOST] ${socket.id}`);
    } else {
      clients[socket.id].isHost = false;
      socket.emit('role_confirmed', { role: 'participant' });
      console.log(`[PARTICIPANT] ${socket.id}`);
    }
    broadcast();
    emitParticipantMarkers();
  });

  // Host submits message
  socket.on('set_message', ({ text }) => {
    if (socket.id !== host) return;
    message = text;
    console.log(`[MESSAGE SET] "${message.substring(0, 40)}${message.length > 40 ? '...' : ''}"`);
    broadcast();
  });

  // Any client updates location
  socket.on('location_update', ({ lat, lng, accuracy }) => {
    if (!clients[socket.id]) return;
    clients[socket.id].lat = lat;
    clients[socket.id].lng = lng;
    clients[socket.id].accuracy = accuracy;
    broadcast();
  });

  // Client denied / no geolocation
  socket.on('location_unavailable', () => {
    if (!clients[socket.id]) return;
    clients[socket.id].lat = null;
    clients[socket.id].lng = null;
    console.log(`[NO LOCATION] ${socket.id}`);
    broadcast();
  });

  socket.on('disconnect', () => {
    console.log(`[-] Client disconnected: ${socket.id}`);
    delete clients[socket.id];
    if (socket.id === host) {
      host = null;
      message = null;
      io.emit('session_ended', { reason: 'Host disconnected.' });
      console.log('[SESSION ENDED] Host left.');
    } else {
      broadcast();
      emitParticipantMarkers();
    }
  });
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const scheme = useHttps ? 'https' : 'http';
  const boxRow = (text) => {
    const w = 48;
    const body =
      text.length > w ? `${text.slice(0, w - 3)}...` : text + ' '.repeat(w - text.length);
    return `║${body}║`;
  };
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║              TELEPHONE — running               ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(boxRow(`  Local:    ${scheme}://localhost:${PORT}`));
  console.log(boxRow(`  Network:  ${scheme}://${ip}:${PORT}`));
  console.log('╠════════════════════════════════════════════════╣');
  if (useHttps) {
    console.log('║  HTTPS (certs/key.pem + cert.pem): LAN geo OK. ║');
    console.log('║  Share the Network URL with participants.      ║');
  } else {
    console.log('║  Share the Network URL with participants.      ║');
    console.log('║                                                ║');
    console.log('║  NOTE: Chrome blocks geolocation on plain      ║');
    console.log('║  http:// for non-localhost. Add ./certs/       ║');
    console.log('║  key.pem + cert.pem (mkcert) to enable HTTPS.  ║');
  }
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
});
