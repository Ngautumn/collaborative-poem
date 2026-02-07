/*
  Clean two-scene controller:
  - P2 Lobby: p5 draws only the yellow/blue/green background + HTML lobby overlay on top.
  - P1 Running: Google Map full-screen + multi-user triangles (Google markers). p5 stays transparent.
*/

let socket = null;
let myId = null;
let players = {};
let roomState = null;

let gpsWatchId = null;
let gpsText = "GPS: waiting";
let myGps = { lat: null, lng: null, accuracy: null, heading: 0 };

let gameStarted = false;
let pendingEnterGame = false;

const metersPerDegLat = 111320;
let gpsCenter = null;
let gpsMetersSmooth = { dx: 0, dy: 0 };

const actionBusy = { start: false };

const SEAT_SLOT_POS = [
  { x: 50, y: 16 },
  { x: 74, y: 30 },
  { x: 74, y: 62 },
  { x: 50, y: 76 },
  { x: 26, y: 62 },
  { x: 26, y: 30 }
];

// ----- DOM refs -----
const ui = {
  overlay: document.getElementById("lobbyOverlay"),
  hostBtn: document.getElementById("hostBtn"),
  startBtn: document.getElementById("startBtn"),
  roomLine: document.getElementById("roomLine"),
  statusText: document.getElementById("statusText"),
  errorText: document.getElementById("errorText"),
  seats: document.getElementById("seats"),
  map: document.getElementById("map"),
  hud: document.getElementById("hud")
};

const statusEl = () => document.getElementById("status");
const accEl = () => document.getElementById("acc");
const coordEl = () => document.getElementById("coord");
const metersEl = () => document.getElementById("meters");
const startGpsBtnEl = () => document.getElementById("startgps");
const recenterBtnEl = () => document.getElementById("recenter");

// ----- Google Map state -----
let gmap = null;
const playerMarkers = {}; // { socketId: google.maps.Marker }

// ----- HUD -----
function setHudStatus(text) {
  if (statusEl()) statusEl().textContent = `Status: ${text}`;
}

function renderHud(meters = null) {
  if (accEl()) accEl().textContent = `Accuracy: ${myGps.accuracy ? `${myGps.accuracy.toFixed(1)}m` : "—"}`;
  if (coordEl()) coordEl().textContent = myGps.lat == null ? "lat/lng: —" : `lat/lng: ${myGps.lat.toFixed(6)}, ${myGps.lng.toFixed(6)}`;
  if (metersEl()) {
    metersEl().textContent = meters ? `dx/dy: ${meters.dx.toFixed(1)}m, ${meters.dy.toFixed(1)}m` : "dx/dy: —";
  }
}

function setError(msg = "") {
  if (ui.errorText) ui.errorText.textContent = msg;
}

function setStatus(msg) {
  if (ui.statusText) ui.statusText.textContent = msg;
}

// ----- Scene switching -----
function setGameScene(active) {
  gameStarted = active;
  if (!active) pendingEnterGame = false;

  // Lobby overlay visible only in lobby
  ui.overlay.style.display = active ? "none" : "flex";

  // HUD visible only in running
  ui.hud.style.display = active ? "block" : "none";

  // Map visible only in running
  ui.map.style.display = active ? "block" : "none";

  // When entering running, build map if possible
  if (active) ensureMap();
}

// ----- Socket -----
function isConnected() {
  return Boolean(socket && socket.connected);
}

function updateActionButtons() {
  const inRoom = Boolean(roomState?.id);
  const isHost = inRoom && roomState?.hostId === myId;
  const inLobby = roomState?.phase === "lobby";

  ui.hostBtn.disabled = !isConnected() || actionBusy.start;
  ui.hostBtn.textContent = isHost ? "You Are Host (Seat 1)" : "Become Host";
  ui.startBtn.disabled = !isConnected() || actionBusy.start || !isHost || !inLobby;
}

function initSocket() {
  if (socket) return;
  socket = io();

  socket.on("connect", () => {
    myId = socket.id;
    setStatus("Connected. Tap + on a seat to join.");
    setHudStatus("Requesting location...");
    startGPS();
    updateActionButtons();
  });

  socket.on("disconnect", () => {
    setStatus("Disconnected. Reconnecting...");
    updateActionButtons();
  });

  socket.on("connect_error", (err) => {
    setError(`Connection failed: ${err?.message || "socket error"}`);
    updateActionButtons();
  });

  socket.on("hello", () => renderSeats());

  socket.on("room-state", (state) => {
    roomState = state;

    // Enter running view only when host started game
    if (state?.phase === "running" && pendingEnterGame) {
      setGameScene(true);
      pendingEnterGame = false;
    }
    // If server says lobby, go back to lobby view
    if (state?.phase !== "running") {
      setGameScene(false);
    }

    renderRoomState();
    updateActionButtons();
  });

  socket.on("players", (allPlayers) => {
    players = allPlayers || {};
    syncMarkers(); // ✅ multiplayer triangles on map
  });

  socket.on("room-error", ({ message }) => {
    setError(message || "Action failed");
    pendingEnterGame = false;
    updateActionButtons();
  });

  socket.on("game-started", () => {
    // server confirmed running
    setGameScene(true);
    pendingEnterGame = false;
  });
}

// ----- GPS -----
function startGPS() {
  if (!("geolocation" in navigator)) {
    gpsText = "GPS: not supported on this device";
    setHudStatus("Geolocation not supported");
    return;
  }

  gpsText = "GPS: requesting permission...";
  setHudStatus("Requesting location...");

  if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);

  gpsWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const accuracy = pos.coords.accuracy;

      myGps.lat = lat;
      myGps.lng = lon;
      myGps.accuracy = accuracy;

      if (pos.coords.heading != null && !Number.isNaN(pos.coords.heading)) {
        myGps.heading = pos.coords.heading;
      }

      if (!gpsCenter) gpsCenter = { lat, lng: lon };

      gpsText = `GPS: ${lat.toFixed(5)}, ${lon.toFixed(5)} (±${Math.round(accuracy)}m)`;
      setHudStatus("GPS locked");
      renderHud(getLocalGpsMeters());

      // emit to server
      if (socket && socket.connected) {
        socket.emit("gps", { lat, lon, accuracy, ts: Date.now() });
      }

      // if running, ensure map exists & recenter first time
      if (gameStarted) {
        ensureMap();
        // update my marker immediately (even before players broadcast)
        updateMarkerForMe();
      }

      renderRoomState();
    },
    (err) => {
      gpsText = `GPS error: ${err.message}`;
      setHudStatus(`GPS failed (${err.code}) ${err.message}`);
      renderRoomState();
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function getLocalGpsMeters() {
  if (myGps.lat == null || myGps.lng == null || !gpsCenter) return null;
  const metersPerDegLng = 111320 * Math.cos((myGps.lat * Math.PI) / 180);
  const dx = (myGps.lng - gpsCenter.lng) * metersPerDegLng;
  const dy = (myGps.lat - gpsCenter.lat) * metersPerDegLat;
  gpsMetersSmooth.dx += (dx - gpsMetersSmooth.dx) * 0.2;
  gpsMetersSmooth.dy += (dy - gpsMetersSmooth.dy) * 0.2;
  return { dx: gpsMetersSmooth.dx, dy: gpsMetersSmooth.dy };
}

// ----- Lobby seats -----
function mySeatIndex() {
  if (!roomState?.seats) return null;
  const i = roomState.seats.findIndex((s) => !s.empty && s.socketId === myId);
  return i >= 0 ? i : null;
}

function autoTakeSeatFromBoard(clientX, clientY) {
  if (!roomState?.id || roomState?.phase !== "lobby") return;
  if (mySeatIndex() !== null) return;

  const iAmHost = roomState.hostId === myId;
  const emptySeats = roomState.seats.filter((s) => s.empty && (iAmHost || s.index !== 0));
  if (emptySeats.length === 0) return;

  const rect = ui.seats.getBoundingClientRect();
  const rx = ((clientX - rect.left) / rect.width) * 100;
  const ry = ((clientY - rect.top) / rect.height) * 100;

  let bestSeatIndex = emptySeats[0].index;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const seat of emptySeats) {
    const pos = SEAT_SLOT_POS[seat.index];
    if (!pos) continue;
    const dx = pos.x - rx;
    const dy = pos.y - ry;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      bestSeatIndex = seat.index;
    }
  }

  setError("");
  socket?.emit("take-seat", { seatIndex: bestSeatIndex });
}

function renderSeats() {
  const seats = roomState?.seats || Array.from({ length: 6 }, (_, index) => ({ index, empty: true }));
  ui.seats.innerHTML = "";

  seats.forEach((seat) => {
    const btn = document.createElement("button");
    const isHostSeat = !seat.empty && roomState?.hostId === seat.socketId;
    const potClass = `pot-${seat.index % 5}`;
    btn.className = `seat slot-${seat.index} ${potClass} ${seat.empty ? "empty" : ""} ${!seat.empty && seat.socketId === myId ? "me" : ""} ${isHostSeat ? "host" : ""}`;
    btn.type = "button";

    if (seat.empty) {
      btn.innerHTML = `<div class="idx">Seat ${seat.index + 1}</div><div class="seat-circle">+</div><div class="seat-shadow"></div>`;
      btn.onclick = () => {
        if (roomState?.phase && roomState.phase !== "lobby") return;
        if (seat.index === 0 && roomState.hostId !== myId) {
          setError("Seat 1 is reserved for host.");
          return;
        }
        setError("");
        socket?.emit("take-seat", { seatIndex: seat.index });
      };
    } else {
      const mine = seat.socketId === myId;
      const hostTag = isHostSeat ? `<div class="host-tag">HOST</div>` : "";
      const occupant = players[seat.socketId];
      const icon = occupant?.role === "cat" ? "🐱" : occupant?.role === "mouse" ? "🐭" : "🙂";
      const seatCircle = mine ? `<div class="seat-circle seated-mark">入座</div>` : `<div class="seat-circle">${icon}</div>`;
      btn.innerHTML = `<div class="idx">Seat ${seat.index + 1}</div><div class="name">${seat.name}</div>${seatCircle}<div class="seat-shadow"></div><div class="meta gps ${seat.gpsReady ? "ok" : "no"}">${seat.gpsReady ? "GPS ready" : "GPS not ready"}</div>${hostTag}`;
      btn.onclick = () => {
        if (mine) socket?.emit("leave-seat");
      };
    }

    ui.seats.appendChild(btn);
  });
}

function renderRoomState() {
  renderSeats();
  updateActionButtons();

  if (!roomState) {
    ui.roomLine.textContent = "Not in a room";
    return;
  }

  const seated = roomState.seats.filter((s) => !s.empty).length;
  const isHost = roomState.hostId === myId;

  ui.roomLine.textContent = `Host: ${isHost ? "You" : roomState.hostId ? "Another player" : "None"} | Seated: ${seated}`;

  if (roomState.phase === "running") {
    const myInfo = players[myId];
    const roleText = myInfo?.role === "cat" ? "Cat" : myInfo?.role === "mouse" ? "Mouse" : "Observer";
    setStatus(`Game running. Your role: ${roleText}. ${gpsText}`);
  } else {
    const seat = mySeatIndex();
    const seatText = seat === null ? "Tap + to take a seat" : `You are in seat ${seat + 1}`;
    const hostHint = seat === null
      ? "Tap 'Become Host' to become host at Seat 1."
      : isHost ? "You are host at Seat 1." : "Tap 'Become Host' to take Seat 1.";
    setStatus(`${seatText}. ${hostHint} ${gpsText}`);
  }
}

// ----- Google Map + markers (triangles) -----
function ensureMap() {
  // Only create map when running and Google API loaded
  if (!gameStarted) return;
  if (!window.__gmLoaded) return;

  if (!gmap) {
    const fallback = { lat: 51.5074, lng: -0.1278 }; // London
    const center = (myGps.lat != null && myGps.lng != null) ? { lat: myGps.lat, lng: myGps.lng } : fallback;

    gmap = new google.maps.Map(ui.map, {
      center,
      zoom: 17,
      disableDefaultUI: true,
      clickableIcons: false,
      gestureHandling: "greedy"
    });
  }

  // Update markers once map exists
  syncMarkers();
}

function triangleSymbol(color, rotationDeg) {
  return {
    path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
    scale: 5,
    rotation: rotationDeg || 0,
    fillColor: color,
    fillOpacity: 1,
    strokeColor: "#ffffff",
    strokeWeight: 2
  };
}

function colorForRole(role) {
  if (role === "cat") return "#ff5a3c";
  if (role === "mouse") return "#2ecc71";
  return "#888888";
}

function updateMarkerForMe() {
  if (!gmap) return;
  if (myGps.lat == null || myGps.lng == null) return;

  const p = players[myId] || { id: myId, name: "me", role: "observer" };
  const pos = { lat: myGps.lat, lng: myGps.lng };

  if (!playerMarkers[myId]) {
    playerMarkers[myId] = new google.maps.Marker({
      map: gmap,
      position: pos,
      title: p.name || "me",
      icon: triangleSymbol(colorForRole(p.role), myGps.heading || 0)
    });
  } else {
    playerMarkers[myId].setMap(gmap);
    playerMarkers[myId].setPosition(pos);
    playerMarkers[myId].setIcon(triangleSymbol(colorForRole(p.role), myGps.heading || 0));
    playerMarkers[myId].setTitle(p.name || "me");
  }
}

function syncMarkers() {
  if (!gmap) return;

  // always ensure "me" is visible if we have GPS
  updateMarkerForMe();

  // others: from server players.gps
  for (const [id, p] of Object.entries(players)) {
    if (!p) continue;
    if (id === myId) continue;

    const gps = p.gps;
    if (!gps || typeof gps.lat !== "number" || typeof gps.lon !== "number") {
      if (playerMarkers[id]) playerMarkers[id].setMap(null);
      continue;
    }

    const pos = { lat: gps.lat, lng: gps.lon };

    if (!playerMarkers[id]) {
      playerMarkers[id] = new google.maps.Marker({
        map: gmap,
        position: pos,
        title: p.name || "player",
        icon: triangleSymbol(colorForRole(p.role), 0)
      });
    } else {
      playerMarkers[id].setMap(gmap);
      playerMarkers[id].setPosition(pos);
      playerMarkers[id].setIcon(triangleSymbol(colorForRole(p.role), 0));
      playerMarkers[id].setTitle(p.name || "player");
    }
  }

  // cleanup removed players
  for (const id of Object.keys(playerMarkers)) {
    if (id === myId) continue;
    if (!players[id]) {
      playerMarkers[id].setMap(null);
      delete playerMarkers[id];
    }
  }
}

// ----- UI bindings -----
function bindUI() {
  ui.seats.addEventListener("click", (e) => {
    if (e.target === ui.seats) autoTakeSeatFromBoard(e.clientX, e.clientY);
  });

  ui.hostBtn.onclick = () => {
    if (!isConnected()) return setError("Not connected.");
    if (!roomState?.id) return setError("Waiting for room state...");
    socket?.emit("set-host", { asHost: true });
    setStatus("Becoming host and taking Seat 1...");
    setError("");
  };

  ui.startBtn.onclick = () => {
    if (!isConnected()) return setError("Not connected.");
    if (!roomState?.id) return setError("Waiting for room state...");
    if (roomState.phase !== "lobby") return;
    if (roomState.hostId !== myId) return setError("Only host can start the game.");

    setError("");
    setStatus("Starting game...");
    pendingEnterGame = true;
    socket?.emit("start-game");
  };

  const startGpsBtn = startGpsBtnEl();
  if (startGpsBtn) {
    startGpsBtn.addEventListener("click", () => {
      startGPS();
      setHudStatus("Requesting location...");
    });
  }

  const recenterBtn = recenterBtnEl();
  if (recenterBtn) {
    recenterBtn.addEventListener("click", () => {
      if (!gmap) return;
      if (myGps.lat == null || myGps.lng == null) return;
      gmap.setCenter({ lat: myGps.lat, lng: myGps.lng });
      gmap.setZoom(18);

      gpsCenter = { lat: myGps.lat, lng: myGps.lng };
      gpsMetersSmooth = { dx: 0, dy: 0 };
      setHudStatus("Center reset");
      renderHud({ dx: 0, dy: 0 });
    });
  }

  updateActionButtons();
}

// ----- p5 -----
function setup() {
  bindUI();
  initSocket();
  createCanvas(windowWidth, windowHeight);
  textFont("Trebuchet MS");

  // Start in lobby view
  setGameScene(false);
}

function drawLobbyBackground() {
  // P2 only (yellow/blue/green)
  noStroke();
  fill("#9ed8ff");
  rect(0, 0, width, height * 0.45);
  fill("#ffe7b9");
  rect(0, height * 0.45, width, height * 0.27);
  fill("#a7d989");
  rect(0, height * 0.72, width, height * 0.28);

  // small cloud decoration (optional)
  fill("#f3f7ff");
  ellipse(width * 0.82, height * 0.16, 130, 82);
}

function draw() {
  // Update HUD text (both scenes)
  renderHud(getLocalGpsMeters());

  if (!gameStarted) {
    // ✅ Lobby = draw the colored background
    background("#000"); // clear old frame
    drawLobbyBackground();
    return;
  }

  // ✅ Running = keep canvas fully transparent so only map shows
  clear();

  // Ensure map exists (if google loaded)
  ensureMap();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// cleanup
window.addEventListener("beforeunload", () => {
  if (gpsWatchId !== null && "geolocation" in navigator) {
    navigator.geolocation.clearWatch(gpsWatchId);
  }
});
