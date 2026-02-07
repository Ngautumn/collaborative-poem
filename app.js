import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

app.use(express.static("public"));

const MAX_SEATS = 6;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 6;
const DEFAULT_ROOM_ID = "LOBBY";
const CATCH_DIST = 0.06;
const CATCH_HOLD_MS = 1200;

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
      startedAt: null
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
    seats: room.seats.map((sid, index) => {
      if (!sid || !players[sid]) return { index, empty: true };
      const p = players[sid];
      return {
        index,
        empty: false,
        socketId: sid,
        name: p.name,
        role: p.role,
        gpsReady: Boolean(p.gps)
      };
    })
  };
}

function emitRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit("room-state", roomPublicState(room));
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
  if (seated.length < 1) {
    return {
      ok: false,
      message: "Need at least 1 seated player before start."
    };
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
    players[sid].role = sid === catId ? "cat" : "mouse";
  });

  room.phase = "running";
  room.startedAt = Date.now();
  emitRoom(room.id);

  io.to(room.id).emit("game-started", {
    roomId: room.id,
    targetCount: room.targetCount,
    catId
  });

  return { ok: true };
}

function tickCatchRules() {
  for (const room of Object.values(rooms)) {
    if (room.phase !== "running") continue;

    const ids = roomPlayerIds(room);
    const cats = ids.map((id) => players[id]).filter((p) => p?.role === "cat");
    const mice = ids.map((id) => players[id]).filter((p) => p?.role === "mouse" && !p.caught);

    for (const cat of cats) {
      for (const mouse of mice) {
        const dx = cat.x - mouse.x;
        const dy = cat.y - mouse.y;
        const d = Math.hypot(dx, dy);
        const key = `${room.id}|${cat.id}|${mouse.id}`;
        const now = Date.now();

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

    io.to(room.id).emit("players", ids.reduce((acc, sid) => {
      if (players[sid]) acc[sid] = players[sid];
      return acc;
    }, {}));
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
    caught: false,
    gps: null
  };

  const defaultRoom = getOrCreateDefaultRoom();
  players[socket.id].roomId = defaultRoom.id;
  socket.join(defaultRoom.id);
  emitRoom(defaultRoom.id);

  socket.emit("hello", { id: socket.id, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, maxSeats: MAX_SEATS });

  socket.on("take-seat", ({ seatIndex }) => {
    const p = players[socket.id];
    if (!p?.roomId) return;

    const room = getRoom(p.roomId);
    if (!room || room.phase !== "lobby") return;

    const idx = Number(seatIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= MAX_SEATS) return;
    if (idx === 0 && room.hostId && room.hostId !== socket.id) return;
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
    if (!room || room.phase !== "lobby") return;

    if (!asHost) {
      if (room.hostId === socket.id) {
        room.hostId = null;
        if (typeof p.seatIndex === "number") {
          p.name = `Player ${p.seatIndex + 1}`;
        }
        emitRoom(room.id);
      }
      return;
    }

    const centerOccupant = room.seats[0];

    if (typeof p.seatIndex !== "number") {
      if (centerOccupant && centerOccupant !== socket.id) {
        const freeSeat = room.seats.findIndex((sid, idx) => idx !== 0 && !sid);
        if (freeSeat === -1) {
          socket.emit("room-error", { message: "No free seat to move current center player." });
          return;
        }
        room.seats[freeSeat] = centerOccupant;
        if (players[centerOccupant]) {
          players[centerOccupant].seatIndex = freeSeat;
          players[centerOccupant].name = `Player ${freeSeat + 1}`;
        }
      }
      room.seats[0] = socket.id;
      p.seatIndex = 0;
      p.name = "Host";
    } else if (p.seatIndex !== 0) {
      room.seats[p.seatIndex] = centerOccupant || null;
      room.seats[0] = socket.id;

      if (centerOccupant && players[centerOccupant]) {
        players[centerOccupant].seatIndex = p.seatIndex;
        players[centerOccupant].name = `Player ${p.seatIndex + 1}`;
      }
      p.seatIndex = 0;
      p.name = "Host";
    } else {
      p.name = "Host";
    }

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
    if (!result.ok) {
      socket.emit("room-error", { message: result.message });
    }
  });

  socket.on("pos", ({ x, y }) => {
    const p = players[socket.id];
    if (!p?.roomId) return;
    if (typeof x !== "number" || typeof y !== "number") return;

    p.x = clamp01(x);
    p.y = clamp01(y);
    p.last = Date.now();
  });

  socket.on("gps", ({ lat, lon, accuracy, ts }) => {
    const p = players[socket.id];
    if (!p) return;

    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return;
    }

    p.gps = {
      lat: Math.max(-90, Math.min(90, lat)),
      lon: Math.max(-180, Math.min(180, lon)),
      accuracy:
        typeof accuracy === "number" && Number.isFinite(accuracy)
          ? Math.max(0, accuracy)
          : null,
      ts: typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now()
    };
    p.last = Date.now();

    if (p.roomId) emitRoom(p.roomId);
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

server.on("error", (err) => {
  if (err?.code === "EADDRINUSE") {
    console.error(`[startup] Port ${PORT} is already in use.`);
    console.error(`[startup] Try: PORT=3001 npm start`);
    return;
  }
  if (err?.code === "EACCES" || err?.code === "EPERM") {
    console.error(`[startup] Permission denied for ${HOST}:${PORT}.`);
    console.error(`[startup] Try: HOST=127.0.0.1 PORT=3001 npm start`);
    return;
  }
  console.error("[startup] Server failed to start:", err);
});

server.listen(PORT, HOST, () => {
  console.log(`Server running: http://${HOST}:${PORT}`);
  console.log(`LAN access: http://<your-ip>:${PORT}`);
});
