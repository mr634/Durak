/**
 * Minimal authoritative WebSocket server for two-player Durak.
 * Run: npm install && node server.js
 *
 * Protocol (JSON text frames):
 * - Client → server
 *   { "type": "create" }     → host room, get room id + seat 0
 *   { "type": "leave" }      → leave room (partner notified)
 *   { "type": "rejoin", "roomId": "ABC123" } → reclaim empty seat after brief disconnect (grace window)
 *   { "type": "join", "roomId": "ABC123" } → seat 1, starts game
 *   { "type": "move", "action": "attack", "card": "9S" }
 *   { "type": "move", "action": "defend", "card": "10S", "against": "9S" }
 *   { "type": "move", "action": "transfer", "card": "9H", "against": "9S" }
 *   { "type": "move", "action": "take" }
 *   { "type": "move", "action": "endTurn" }
 *
 * - Server → client
 *   { "type": "joined", "roomId", "seat", "waiting": true|false }
 *   { "type": "start", "roomId" }           → to host when guest joins
 *   { "type": "state", "payload": { ... } } → per-seat view (opponent hand = counts only)
 *   { "type": "error", "message": "..." }
 *   { "type": "room_closed", "reason": "peer_disconnected"|"peer_left" }
 *   { "type": "left" }
 *
 * Browser UI: http://localhost:8787/ (same PORT as WebSocket)
 *
 * HTTP: GET /api/waiting-room → { "roomId": "<code>" | null } — host alone in lobby
 */

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");
const {
  createInitialState,
  attack,
  defend,
  transfer,
  take,
  endTurn,
  getState,
} = require("./durak.js");

const PORT = Number(process.env.PORT) || 8787;

/** Long cache for static assets in production; no-store locally so replaced PNGs always apply. */
const ASSET_CACHE_CONTROL =
  process.env.ASSET_CACHE === "1"
    ? "public, max-age=31536000, immutable"
    : "no-store";

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function readLinesFile(absPath) {
  try {
    return fs
      .readFileSync(absPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listImageBasenames(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f));
  } catch {
    return [];
  }
}

function safeJoinUnder(root, rel) {
  const resolved = path.resolve(path.join(root, rel));
  const rootR = path.resolve(root);
  const sep = rootR.endsWith(path.sep) ? rootR : rootR + path.sep;
  if (resolved !== rootR && !resolved.startsWith(sep)) return null;
  return resolved;
}

/**
 * Stream a file with ETag / Last-Modified so browsers re-fetch after PNGs change
 * (CSS background images often stick without validators even with Cache-Control: no-cache).
 */
function sendAssetFile(req, res, abs, ext, cacheControl) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    res.end();
    return;
  }
  const etag = `"${stat.size}-${stat.mtimeMs}"`;
  const lastModified = stat.mtime.toUTCString();
  const inm = req.headers["if-none-match"];
  if (inm && inm === etag) {
    res.writeHead(304, {
      ETag: etag,
      "Last-Modified": lastModified,
      "Cache-Control": cacheControl,
    });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": cacheControl,
    ETag: etag,
    "Last-Modified": lastModified,
  });
  const stream = fs.createReadStream(abs);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

/** @param {ReturnType<typeof createInitialState>} state */
function viewForSeat(state, seat) {
  const base = getState(state);
  return {
    ...base,
    hands: base.hands.map((hand, i) =>
      i === seat ? hand : { count: hand.length },
    ),
    you: seat,
  };
}

/** @typedef {{ state: ReturnType<typeof createInitialState> | null, seats: (import("ws") | null)[] }} Room */

/** @param {Room} room */
function broadcastState(room) {
  if (!room.state) return;
  for (let seat = 0; seat < 2; seat++) {
    const ws = room.seats[seat];
    wsSend(ws, {
      type: "state",
      payload: viewForSeat(room.state, seat),
    });
  }
}

function randomRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++)
    id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {number} seat
 * @param {{ action: string, card?: string, against?: string }} msg
 */
function applyMove(state, seat, msg) {
  switch (msg.action) {
    case "attack":
      if (state.attacker !== seat) throw new Error("Only the attacker can attack");
      return attack(state, msg.card);
    case "defend":
      if (state.defender !== seat) throw new Error("Only the defender can defend");
      return defend(state, msg.card, msg.against);
    case "transfer":
      if (state.defender !== seat) throw new Error("Only the defender can transfer");
      return transfer(state, msg.card, msg.against);
    case "take":
      if (state.defender !== seat) throw new Error("Only the defender can take");
      return take(state);
    case "endTurn":
      if (state.attacker !== seat)
        throw new Error("Only the attacker can end the round after a full defense.");
      return endTurn(state);
    default:
      throw new Error(`Unknown action: ${msg.action}`);
  }
}

/** @type {Map<string, Room>} */
const rooms = new Map();

/** After abrupt WS drop mid-game, keep room alive so Safari background can reconnect */
const DISCONNECT_GRACE_MS =
  Number(process.env.DISCONNECT_GRACE_MS) || 90_000;

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const roomGraceTimers = new Map();

function cancelRoomGrace(roomId) {
  const t = roomGraceTimers.get(roomId);
  if (t != null) clearTimeout(t);
  roomGraceTimers.delete(roomId);
}

function finalizeGraceRoom(roomId) {
  cancelRoomGrace(roomId);
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.seats[0] && room.seats[1]) return;
  const survivor = room.seats[0] || room.seats[1];
  rooms.delete(roomId);
  if (survivor) {
    const octx = survivor.__durakCtx;
    if (octx) {
      delete octx.roomId;
      delete octx.seat;
    }
    wsSend(survivor, { type: "room_closed", reason: "peer_disconnected" });
  }
}

function scheduleRoomGrace(roomId) {
  cancelRoomGrace(roomId);
  roomGraceTimers.set(
    roomId,
    setTimeout(() => {
      roomGraceTimers.delete(roomId);
      finalizeGraceRoom(roomId);
    }, DISCONNECT_GRACE_MS),
  );
}

/** @param {import("ws") | null | undefined} ws */
function wsSend(ws, payload) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
}

/**
 * If ctx claims membership but the room map disagrees, drop stale refs (avoids
 * permanent "Already in a room" after races or orphaned state).
 */
function clearStaleRoomMembership(ws, ctx) {
  const roomId = ctx.roomId;
  const seat = ctx.seat;
  if (roomId == null || seat == null) return;
  const room = rooms.get(roomId);
  if (!room || room.seats[seat] !== ws) {
    delete ctx.roomId;
    delete ctx.seat;
  }
}

/**
 * Explicit leave / intentional teardown — closes room for partner immediately.
 */
function destroyRoom(ws, ctx, reason = "peer_disconnected") {
  const roomId = ctx.roomId;
  const seat = ctx.seat;
  if (roomId == null || seat == null) return;
  const room = rooms.get(roomId);
  cancelRoomGrace(roomId);
  if (!room || room.seats[seat] !== ws) {
    delete ctx.roomId;
    delete ctx.seat;
    return;
  }
  const other = room.seats[1 - seat];
  rooms.delete(roomId);
  delete ctx.roomId;
  delete ctx.seat;
  if (other) {
    const octx = other.__durakCtx;
    if (octx) {
      delete octx.roomId;
      delete octx.seat;
    }
    wsSend(other, { type: "room_closed", reason });
  }
}

/**
 * Socket closed without leave — lobby drops immediately; mid-game gets reconnect grace.
 */
function handleAbruptDisconnect(ws, ctx) {
  const roomId = ctx.roomId;
  const seat = ctx.seat;
  if (roomId == null || seat == null) return;
  const room = rooms.get(roomId);
  if (!room || room.seats[seat] !== ws) {
    delete ctx.roomId;
    delete ctx.seat;
    return;
  }
  room.seats[seat] = null;
  delete ctx.roomId;
  delete ctx.seat;

  const mate = room.seats[1 - seat];
  if (!mate) {
    cancelRoomGrace(roomId);
    rooms.delete(roomId);
    return;
  }

  if (room.state == null) {
    cancelRoomGrace(roomId);
    const octx = mate.__durakCtx;
    if (octx) {
      delete octx.roomId;
      delete octx.seat;
    }
    wsSend(mate, { type: "room_closed", reason: "peer_disconnected" });
    rooms.delete(roomId);
    return;
  }

  scheduleRoomGrace(roomId);
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(String(req.url || "").split("?")[0]);

  if (req.method === "GET" && pathname === "/api/game-over-data") {
    const winLines = readLinesFile(path.join(__dirname, "messages/winner-lines.txt"));
    const loserLines = readLinesFile(path.join(__dirname, "messages/loser-lines.txt"));
    const winDir = path.join(__dirname, "assets/game-over/win");
    const loseDir = path.join(__dirname, "assets/game-over/lose");
    const winnerImages = listImageBasenames(winDir).map(
      (f) => `/assets/game-over/win/${encodeURIComponent(f)}`,
    );
    const loserImages = listImageBasenames(loseDir).map(
      (f) => `/assets/game-over/lose/${encodeURIComponent(f)}`,
    );
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        winnerLines: winLines,
        loserLines,
        winnerImages,
        loserImages,
      }),
    );
    return;
  }

  if (req.method === "GET" && pathname === "/api/waiting-room") {
    let waitingId = null;
    for (const [id, room] of rooms) {
      if (
        room.state == null &&
        room.seats[0] != null &&
        room.seats[1] == null
      ) {
        waitingId = id;
        break;
      }
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ roomId: waitingId }));
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/cards/")) {
    const rel = pathname.slice("/cards/".length).replace(/^\/+|\/+$/g, "");
    const abs = safeJoinUnder(path.join(__dirname, "cards"), rel);
    if (!abs) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    sendAssetFile(req, res, abs, ext, ASSET_CACHE_CONTROL);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/assets/")) {
    const rel = pathname.slice("/assets/".length).replace(/^\/+|\/+$/g, "");
    const abs = safeJoinUnder(path.join(__dirname, "assets"), rel);
    if (!abs) {
      res.writeHead(404);
      res.end();
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const cardsRoot = path.resolve(path.join(__dirname, "assets", "cards"));
    const resolvedAbs = path.resolve(abs);
    const inCardsArt =
      resolvedAbs === cardsRoot ||
      resolvedAbs.startsWith(cardsRoot + path.sep);
    const cacheCtrl =
      inCardsArt && /\.(png|jpe?g|webp|gif)$/i.test(abs)
        ? "public, max-age=604800, stale-while-revalidate=86400"
        : ASSET_CACHE_CONTROL;
    sendAssetFile(req, res, abs, ext, cacheCtrl);
    return;
  }

  if (req.method === "GET" && pathname === "/iphone-preview.html") {
    const file = path.join(__dirname, "iphone-preview.html");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing iphone-preview.html next to server.js.\n");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/desktop-preview.html") {
    const file = path.join(__dirname, "desktop-preview.html");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing desktop-preview.html next to server.js.\n");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
    return;
  }

  if (req.method === "GET" && (pathname === "/" || pathname === "/client.html")) {
    const file = path.join(__dirname, "client.html");
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Missing client.html next to server.js.\n");
        return;
      }
      let html = data.toString("utf8");
      let cardBackMtime = "0";
      try {
        cardBackMtime = String(
          fs.statSync(path.join(__dirname, "assets/cards/card_back.png")).mtimeMs,
        );
      } catch {
        /* missing file — leave 0; UI falls back to stripes */
      }
      html = html.replace(/CARD_BACK_MT/g, cardBackMtime);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(
    `Durak server — open the game UI at http://localhost:${PORT}/\n` +
      `WebSocket: ws://localhost:${PORT}\n`,
  );
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  /** @type {{ roomId?: string, seat?: number }} */
  const ctx = {};
  ws.__durakCtx = ctx;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      wsSend(ws, { type: "error", message: "Invalid JSON" });
      return;
    }

    try {
      if (msg.type === "leave") {
        destroyRoom(ws, ctx, "peer_left");
        wsSend(ws, { type: "left" });
        return;
      }

      if (msg.type === "create") {
        clearStaleRoomMembership(ws, ctx);
        if (ctx.roomId != null) {
          const room = rooms.get(ctx.roomId);
          const soloHostLobby =
            ctx.seat === 0 &&
            room &&
            room.state == null &&
            room.seats[0] === ws &&
            room.seats[1] == null;
          if (soloHostLobby) {
            cancelRoomGrace(ctx.roomId);
            rooms.delete(ctx.roomId);
            delete ctx.roomId;
            delete ctx.seat;
          } else {
            throw new Error(
              'Already in a room — click "Leave room" or reconnect.',
            );
          }
        }
        let roomId;
        do {
          roomId = randomRoomId();
        } while (rooms.has(roomId));
        rooms.set(roomId, { state: null, seats: [ws, null] });
        ctx.roomId = roomId;
        ctx.seat = 0;
        wsSend(ws, {
          type: "joined",
          roomId,
          seat: 0,
          waiting: true,
        });
        return;
      }

      if (msg.type === "join") {
        clearStaleRoomMembership(ws, ctx);
        const roomId = String(msg.roomId || "")
          .trim()
          .toUpperCase();
        if (ctx.roomId != null) {
          if (ctx.roomId === roomId && ctx.seat === 1) {
            const roomAgain = rooms.get(roomId);
            if (
              roomAgain &&
              roomAgain.seats[1] === ws &&
              roomAgain.state != null
            ) {
              wsSend(ws, {
                type: "joined",
                roomId,
                seat: 1,
                waiting: false,
              });
              broadcastState(roomAgain);
              return;
            }
          }
          throw new Error(
            'Already in a room — click "Leave room" or reconnect.',
          );
        }
        const room = rooms.get(roomId);
        if (!room) throw new Error("Room not found");
        if (room.state != null)
          throw new Error(
            "Game already in progress — reopen this tab to reconnect.",
          );
        if (room.seats[1]) throw new Error("Room is full");
        cancelRoomGrace(roomId);
        room.seats[1] = ws;
        ctx.roomId = roomId;
        ctx.seat = 1;
        room.state = createInitialState();
        wsSend(ws, {
          type: "joined",
          roomId,
          seat: 1,
          waiting: false,
        });
        const host = room.seats[0];
        wsSend(host, { type: "start", roomId });
        broadcastState(room);
        return;
      }

      if (msg.type === "rejoin") {
        clearStaleRoomMembership(ws, ctx);
        if (ctx.roomId != null)
          throw new Error(
            'Already connected — click "Cancel game" if stuck.',
          );
        const roomId = String(msg.roomId || "")
          .trim()
          .toUpperCase();
        const room = rooms.get(roomId);
        if (!room) throw new Error("Room not found");
        let seat = null;
        if (room.seats[0] == null && room.seats[1] != null) seat = 0;
        else if (room.seats[1] == null && room.seats[0] != null) seat = 1;
        else throw new Error("Cannot reconnect right now");
        room.seats[seat] = ws;
        ctx.roomId = roomId;
        ctx.seat = seat;
        cancelRoomGrace(roomId);
        const waiting =
          room.state == null && seat === 0 && room.seats[1] == null;
        wsSend(ws, {
          type: "joined",
          roomId,
          seat,
          waiting,
        });
        if (room.state != null) broadcastState(room);
        return;
      }

      if (msg.type === "move") {
        const { roomId } = ctx;
        const seat = ctx.seat;
        if (roomId == null || seat == null) throw new Error("Join a room first");
        const room = rooms.get(roomId);
        if (!room || room.state == null) throw new Error("Game not started");
        room.state = applyMove(room.state, seat, msg);
        broadcastState(room);
        return;
      }

      wsSend(ws, {
        type: "error",
        message: `Unknown type: ${msg.type}`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      wsSend(ws, { type: "error", message });
    }
  });

  ws.on("close", () => {
    handleAbruptDisconnect(ws, ctx);
  });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Stop the other server or set PORT.\n` +
        `  PowerShell:  $env:PORT=8788; npm start`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(
    `Durak — http://localhost:${PORT}/   WebSocket ws://localhost:${PORT}`,
  );
});
