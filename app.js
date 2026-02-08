import fs from "fs";
import path from "path";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";

function loadLocalEnv() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadLocalEnv();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.use(express.static("public"));

const MAX_SEATS = 6;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 4;
const DEFAULT_ROOM_ID = "LOBBY";

const CATCH_DIST = 0.06;
const CATCH_HOLD_MS = 1200;
const ROUND_MS = 5 * 60 * 1000;

const players = {};
const rooms = {};
const proximityTimers = new Map();

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function getOrCreateDefaultRoom() {
  if (!rooms[DEFAULT_ROOM_ID]) {
    rooms[DEFAULT_ROOM_ID] = {
      id: DEFAULT_ROOM_ID,
      hostId: null,
      targetCount: MIN_PLAYERS,
      phase: "lobby",
      seats: Array.from({ length: MAX_SEATS }, () => null),
      startedAt: null,
      endsAt: null
    };
  }
  return rooms[DEFAULT_ROOM_ID];
}

function getRoom(roomId) {
  return roomId ? rooms[roomId] : null;
}

function roomPlayerIds(room) {
  return room.seats.filter(Boolean);
}

function roomPublicState(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    targetCount: room.targetCount,
    phase: room.phase,
    startedAt: room.startedAt,
    endsAt: room.endsAt,
    seats: room.seats.map((sid, index) => {
      if (!sid || !players[sid]) return { index, empty: true };
      const p = players[sid];
      return {
        index,
        empty: false,
        socketId: sid,
        name: p.name,
        role: p.role
      };
    })
  };
}

function emitRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit("room-state", roomPublicState(room));
}

function endGame(room, reason = "time") {
  if (!room) return;

  room.phase = "lobby";
  room.startedAt = null;
  room.endsAt = null;

  for (const sid of roomPlayerIds(room)) {
    if (!players[sid]) continue;
    players[sid].role = "observer";
    players[sid].caught = false;
  }

  for (const k of proximityTimers.keys()) {
    if (k.startsWith(`${room.id}|`)) proximityTimers.delete(k);
  }

  emitRoom(room.id);
  io.to(room.id).emit("game-ended", { roomId: room.id, reason });
}

function clearPlayerFromRoom(socketId) {
  const p = players[socketId];
  if (!p?.roomId) return;

  const room = rooms[p.roomId];
  if (!room) {
    p.roomId = null;
    p.seatIndex = null;
    return;
  }

  if (typeof p.seatIndex === "number" && room.seats[p.seatIndex] === socketId) {
    room.seats[p.seatIndex] = null;
  }

  if (room.hostId === socketId) {
    room.hostId = null;
  }

  p.roomId = null;
  p.seatIndex = null;
  p.role = "observer";

  if (roomPlayerIds(room).length === 0 && room.id !== DEFAULT_ROOM_ID) {
    delete rooms[room.id];
    return;
  }

  if (roomPlayerIds(room).length === 0 && room.id === DEFAULT_ROOM_ID) {
    room.hostId = null;
    room.phase = "lobby";
    room.startedAt = null;
    room.endsAt = null;
    room.targetCount = MIN_PLAYERS;
    room.seats = Array.from({ length: MAX_SEATS }, () => null);
  }

  emitRoom(room.id);
}

function startGame(room, bySocketId) {
  if (room.hostId !== bySocketId) {
    return { ok: false, message: "Only host can start the game." };
  }
  if (room.phase !== "lobby") {
    return { ok: false, message: "Game already started." };
  }

  const seated = roomPlayerIds(room);
  if (seated.length < 3 || seated.length > 4) {
    return { ok: false, message: "Need 3-4 seated players (1 cat + 2-3 mice)." };
  }

  const catIndex = Math.floor(Math.random() * seated.length);
  const catId = seated[catIndex];
  room.targetCount = seated.length;

  seated.forEach((sid) => {
    if (!players[sid]) return;
    players[sid].caught = false;
    players[sid].x = Math.random();
    players[sid].y = Math.random();
    players[sid].last = Date.now();
    players[sid].role = "mouse";
  });
  if (players[catId]) players[catId].role = "cat";

  room.phase = "running";
  room.startedAt = Date.now();
  room.endsAt = room.startedAt + ROUND_MS;

  emitRoom(room.id);

  io.to(room.id).emit("game-started", {
    roomId: room.id,
    targetCount: room.targetCount,
    catId,
    endsAt: room.endsAt
  });

  return { ok: true };
}

function tickCatchRules() {
  const now = Date.now();

  for (const room of Object.values(rooms)) {
    if (room.phase !== "running") continue;

    if (typeof room.endsAt === "number" && now >= room.endsAt) {
      endGame(room, "time");
      continue;
    }

    const ids = roomPlayerIds(room);
    const cats = ids.map((id) => players[id]).filter((p) => p?.role === "cat");
    const mice = ids.map((id) => players[id]).filter((p) => p?.role === "mouse" && !p?.caught);

    for (const cat of cats) {
      for (const mouse of mice) {
        const dx = cat.x - mouse.x;
        const dy = cat.y - mouse.y;
        const d = Math.hypot(dx, dy);
        const key = `${room.id}|${cat.id}|${mouse.id}`;

        if (d < CATCH_DIST) {
          if (!proximityTimers.has(key)) proximityTimers.set(key, now);
          const start = proximityTimers.get(key);
          if (now - start >= CATCH_HOLD_MS) {
            mouse.caught = true;
            io.to(room.id).emit("caught", {
              roomId: room.id,
              mouseId: mouse.id,
              byCatId: cat.id
            });
            proximityTimers.delete(key);
          }
        } else {
          proximityTimers.delete(key);
        }
      }
    }

    io.to(room.id).emit(
      "players",
      ids.reduce((acc, sid) => {
        if (players[sid]) acc[sid] = players[sid];
        return acc;
      }, {})
    );
  }
}

setInterval(tickCatchRules, 150);

io.on("connection", (socket) => {
  players[socket.id] = {
    id: socket.id,
    name: "player",
    role: "observer",
    roomId: null,
    seatIndex: null,
    x: Math.random(),
    y: Math.random(),
    last: Date.now(),
    caught: false
  };

  const defaultRoom = getOrCreateDefaultRoom();
  players[socket.id].roomId = defaultRoom.id;
  socket.join(defaultRoom.id);
  emitRoom(defaultRoom.id);

  socket.emit("hello", {
    id: socket.id,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    maxSeats: MAX_SEATS
  });

  socket.on("take-seat", ({ seatIndex }) => {
    const p = players[socket.id];
    if (!p?.roomId) return;

    const room = getRoom(p.roomId);
    if (!room || room.phase !== "lobby") return;

    const idx = Number(seatIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_SEATS) return;

    if (idx === 0 && room.hostId !== socket.id) {
      socket.emit("room-error", { message: "Seat 1 is reserved for host." });
      return;
    }
    if (room.seats[idx] && room.seats[idx] !== socket.id) return;

    if (typeof p.seatIndex === "number" && room.seats[p.seatIndex] === socket.id) {
      room.seats[p.seatIndex] = null;
    }

    room.seats[idx] = socket.id;
    p.seatIndex = idx;
    p.name = `Player ${idx + 1}`;
    emitRoom(room.id);
  });

  socket.on("set-host", ({ asHost }) => {
    const p = players[socket.id];
    if (!p?.roomId) return;

    const room = getRoom(p.roomId);
    if (!room) return;

    if (!asHost) {
      if (room.hostId === socket.id) {
        room.hostId = null;
        if (typeof p.seatIndex === "number") p.name = `Player ${p.seatIndex + 1}`;
        emitRoom(room.id);
      }
      return;
    }

    const hostSeatIndex = 0;
    const hostSeatOccupant = room.seats[hostSeatIndex];
    const myCurrentSeat = typeof p.seatIndex === "number" ? p.seatIndex : null;

    if (hostSeatOccupant && hostSeatOccupant !== socket.id) {
      if (myCurrentSeat !== null) {
        room.seats[myCurrentSeat] = hostSeatOccupant;
        if (players[hostSeatOccupant]) {
          players[hostSeatOccupant].seatIndex = myCurrentSeat;
          players[hostSeatOccupant].name = `Player ${myCurrentSeat + 1}`;
        }
      } else {
        const freeSeat = room.seats.findIndex((sid, idx) => idx !== hostSeatIndex && !sid);
        if (freeSeat !== -1) {
          room.seats[freeSeat] = hostSeatOccupant;
          if (players[hostSeatOccupant]) {
            players[hostSeatOccupant].seatIndex = freeSeat;
            players[hostSeatOccupant].name = `Player ${freeSeat + 1}`;
          }
        } else if (players[hostSeatOccupant]) {
          players[hostSeatOccupant].seatIndex = null;
          players[hostSeatOccupant].name = "player";
          players[hostSeatOccupant].role = "observer";
        }
      }
    }

    if (myCurrentSeat !== null && myCurrentSeat !== hostSeatIndex) {
      room.seats[myCurrentSeat] = null;
    }

    room.seats[hostSeatIndex] = socket.id;
    p.seatIndex = hostSeatIndex;
    p.name = "Host";
    room.hostId = socket.id;

    emitRoom(room.id);
  });

  socket.on("leave-seat", () => {
    const p = players[socket.id];
    if (!p?.roomId) return;

    const room = getRoom(p.roomId);
    if (!room || room.phase !== "lobby") return;

    if (typeof p.seatIndex === "number" && room.seats[p.seatIndex] === socket.id) {
      if (room.hostId === socket.id) room.hostId = null;
      room.seats[p.seatIndex] = null;
      p.seatIndex = null;
      p.name = "player";
      p.role = "observer";
      emitRoom(room.id);
    }
  });

  socket.on("start-game", () => {
    const p = players[socket.id];
    if (!p?.roomId) return;

    const room = getRoom(p.roomId);
    if (!room) return;

    const result = startGame(room, socket.id);
    if (!result.ok) socket.emit("room-error", { message: result.message });
  });

  socket.on("pos", ({ x, y }) => {
    const p = players[socket.id];
    if (!p?.roomId) return;
    if (typeof x !== "number" || typeof y !== "number") return;

    const room = getRoom(p.roomId);
    if (room?.phase === "running" && p.role === "mouse" && p.caught) {
      return;
    }

    p.x = clamp01(x);
    p.y = clamp01(y);
    p.last = Date.now();
  });

  socket.on("disconnect", () => {
    clearPlayerFromRoom(socket.id);
    delete players[socket.id];

    for (const k of proximityTimers.keys()) {
      if (k.includes(`|${socket.id}|`) || k.endsWith(`|${socket.id}`)) {
        proximityTimers.delete(k);
      }
    }
  });
});

// ----- Server startup -----
server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`[startup] Port ${PORT} is already in use.`);
    console.error("[startup] Try: PORT=3001 npm start");
    return;
  }
  if (err?.code === "EACCES" || err?.code === "EPERM") {
    console.error(`[startup] Permission denied for ${HOST}:${PORT}.`);
    console.error("[startup] Try: HOST=0.0.0.0 PORT=3001 npm start");
    return;
  }
  console.error("[startup] Server failed to start:", err);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running: http://${HOST}:${PORT}`);
  console.log(`LAN access: http://<your-ip>:${PORT}`);
});
