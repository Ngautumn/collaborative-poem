/* global io, createCanvas, textFont, windowWidth, windowHeight, noStroke, fill, rect, ellipse, background, clear, resizeCanvas */

/*
  Clean two-scene controller:
  - P2 Lobby: p5 draws only the yellow/blue/green background + HTML lobby overlay on top.
  - P1 Running: p5 stays transparent.
*/

let socket = null;
let myId = null;
let players = {};
let roomState = null;
const root = /** @type {any} */ (window);
let mapScene = null;
let playerController = null;
let timerLoopId = null;
let localGameEndsAt = null;

let gameStarted = false;
let pendingEnterGame = false;

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
  coverScene: document.getElementById("coverScene"),
  gameScene: document.getElementById("gameScene"),
  overlay: document.getElementById("lobbyOverlay"),
  hostBtn: document.getElementById("hostBtn"),
  startBtn: document.getElementById("startBtn"),
  roomLine: document.getElementById("roomLine"),
  statusText: document.getElementById("statusText"),
  errorText: document.getElementById("errorText"),
  seats: document.getElementById("seats"),
  hud: document.getElementById("hud")
};

const statusEl = () => document.getElementById("status");
const timerEl = () => document.getElementById("timer");

// ----- HUD -----
function setHudStatus(text) {
  if (statusEl()) statusEl().textContent = `Status: ${text}`;
}

function setError(msg = "") {
  if (ui.errorText) ui.errorText.textContent = msg;
}

function setStatus(msg) {
  if (ui.statusText) ui.statusText.textContent = msg;
}

function formatLeftMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function renderTimer() {
  const t = timerEl();
  if (!t) return;
  if (!gameStarted) {
    t.textContent = "--:--";
    return;
  }

  const targetEndsAt = Number.isFinite(roomState?.endsAt) ? roomState.endsAt : localGameEndsAt;
  if (!Number.isFinite(targetEndsAt)) {
    t.textContent = "--:--";
    return;
  }

  const left = targetEndsAt - Date.now();
  t.textContent = formatLeftMs(left);
}

function startTimerLoop() {
  if (timerLoopId !== null) return;
  timerLoopId = window.setInterval(renderTimer, 250);
}

// ----- Scene switching -----
function setGameScene(active) {
  gameStarted = active;
  if (!active) {
    pendingEnterGame = false;
    localGameEndsAt = null;
  }

  document.body.classList.toggle("scene-cover", !active);
  document.body.classList.toggle("scene-game", active);

  if (ui.coverScene) ui.coverScene.style.display = active ? "none" : "block";
  if (ui.gameScene) ui.gameScene.style.display = active ? "block" : "none";
  if (active) ensureLocalPlayer();
  playerController?.setEnabled(active);
  renderTimer();
}

// ----- Socket -----
function isConnected() {
  return Boolean(socket && socket.connected);
}

function updateActionButtons() {
  const inRoom = Boolean(roomState?.id);
  const inLobby = roomState?.phase === "lobby";
  const isHost = inRoom && roomState?.hostId === myId;

  ui.hostBtn.disabled = !isConnected() || actionBusy.start;
  ui.hostBtn.textContent = isHost ? "You Are Host (Seat 1)" : "Become Host";
  ui.startBtn.disabled = !isConnected() || actionBusy.start || !inLobby;
}

function initSocket() {
  if (socket) return;
  socket = io();

  socket.on("connect", () => {
    myId = socket.id;
    ensureLocalPlayer();
    playerController?.setSocket(socket);
    setStatus("Connected. Tap + on a seat to join.");
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

    // Allow local enter-game flow even if server still reports lobby.
    const serverRunning = state?.phase === "running";
    const shouldShowGame = serverRunning || pendingEnterGame;
    setGameScene(shouldShowGame);
    if (serverRunning) {
      pendingEnterGame = false;
      if (Number.isFinite(state.endsAt)) {
        localGameEndsAt = state.endsAt;
      }
    }

    renderRoomState();
    updateActionButtons();
    renderTimer();
  });

  socket.on("players", (allPlayers) => {
    const myLocal = myId ? players[myId] : null;
    players = allPlayers || {};
    if (myId && myLocal && !players[myId]) {
      players[myId] = myLocal;
    }
    if (gameStarted) ensureLocalPlayer();
  });

  socket.on("room-error", ({ message }) => {
    setError(message || "Action failed");
    updateActionButtons();
  });

  socket.on("game-started", () => {
    // server confirmed running
    setGameScene(true);
    pendingEnterGame = false;
    if (Number.isFinite(roomState?.endsAt)) {
      localGameEndsAt = roomState.endsAt;
    }
  });
}

// ----- Lobby seats -----
function mySeatIndex() {
  if (!roomState?.seats) return null;
  const i = roomState.seats.findIndex((s) => !s.empty && s.socketId === myId);
  return i >= 0 ? i : null;
}

function ensureLocalPlayer() {
  if (!myId) return;
  if (!players[myId]) {
    players[myId] = {
      id: myId,
      role: "observer",
      x: 0.5,
      y: 0.5,
      caught: false
    };
  }
  if (!Number.isFinite(players[myId].x)) players[myId].x = 0.5;
  if (!Number.isFinite(players[myId].y)) players[myId].y = 0.5;
  if (typeof players[myId].caught !== "boolean") players[myId].caught = false;
}

function applySeatSpawnForMe() {
  if (!myId) return;
  ensureLocalPlayer();
  const seat = mySeatIndex();
  if (seat === null) return;
  const anchors = [
    { x: 0.50, y: 0.16 },
    { x: 0.76, y: 0.31 },
    { x: 0.76, y: 0.65 },
    { x: 0.50, y: 0.80 },
    { x: 0.24, y: 0.65 },
    { x: 0.24, y: 0.31 }
  ];
  const a = anchors[seat] || { x: 0.5, y: 0.5 };
  if (!Number.isFinite(players[myId].x)) players[myId].x = a.x;
  if (!Number.isFinite(players[myId].y)) players[myId].y = a.y;
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
      btn.innerHTML = `<div class="idx">Seat ${seat.index + 1}</div><div class="name">${seat.name}</div>${seatCircle}<div class="seat-shadow"></div>${hostTag}`;
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
    setStatus(`Game running. Your role: ${roleText}.`);
  } else {
    const seat = mySeatIndex();
    const seatText = seat === null ? "Tap + to take a seat" : `You are in seat ${seat + 1}`;
    const hostHint = seat === null
      ? "Tap 'Become Host' to become host at Seat 1."
      : isHost ? "You are host at Seat 1." : "Tap 'Become Host' to take Seat 1.";
    setStatus(`${seatText}. ${hostHint}`);
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

    setError("");
    setStatus("Game scene opened.");
    pendingEnterGame = true;
    localGameEndsAt = Date.now() + (5 * 60 * 1000);
    applySeatSpawnForMe();
    ensureLocalPlayer();
    players[myId].caught = false;
    setGameScene(true);
    playerController?.setEnabled(true);
    socket?.emit("start-game");
  };

  updateActionButtons();
}

// ----- p5 -----
function setup() {
  bindUI();
  createCanvas(windowWidth, windowHeight);
  textFont("Trebuchet MS");
  mapScene = root.appMapScene?.create ? root.appMapScene.create() : null;
  playerController = root.appPlayers?.create
    ? root.appPlayers.create({
      getPlayers: () => players,
      getMyId: () => myId,
      onStatus: (t) => setHudStatus(t)
    })
    : null;

  initSocket();
  startTimerLoop();

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
  if (!gameStarted) {
    // Lobby = draw the colored background
    background("#000"); // clear old frame
    drawLobbyBackground();
    return;
  }

  // Running = draw cartoon map in game scene
  if (mapScene?.draw) {
    mapScene.draw({ roomState, players, myId });
  } else {
    clear();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
