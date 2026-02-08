/* eslint-env browser */
/* global width, height, background, noStroke, fill, rect, ellipse, circle, stroke, strokeWeight, line, noFill, textAlign, textSize, text, CENTER, LEFT, TOP */

(function bootstrapCartoonMap() {
  const root = /** @type {any} */ (window);

  function roleColor(role, isMe) {
    if (isMe) return "#4c8bf5";
    if (role === "cat") return "#f08c52";
    if (role === "mouse") return "#8fa8ff";
    return "#c7c1d9";
  }

  function create() {
    const localRoleFallback = {};
    const seatAnchors = [
      { x: 0.50, y: 0.16 },
      { x: 0.76, y: 0.31 },
      { x: 0.76, y: 0.65 },
      { x: 0.50, y: 0.80 },
      { x: 0.24, y: 0.65 },
      { x: 0.24, y: 0.31 }
    ];

    function drawBaseMap() {
      background("#f4e7c8");

      const area = {
        x: 0,
        y: 0,
        w: width,
        h: height
      };

      // maze walls (cartoon chunky)
      stroke("#7a5e58");
      strokeWeight(22);
      const lines = [
        [0.16, 0.18, 0.16, 0.80],
        [0.32, 0.10, 0.32, 0.62],
        [0.50, 0.24, 0.50, 0.90],
        [0.68, 0.10, 0.68, 0.72],
        [0.84, 0.24, 0.84, 0.90],
        [0.08, 0.26, 0.40, 0.26],
        [0.28, 0.44, 0.74, 0.44],
        [0.08, 0.62, 0.56, 0.62],
        [0.44, 0.80, 0.92, 0.80]
      ];
      for (const l of lines) {
        line(
          area.x + l[0] * area.w,
          area.y + l[1] * area.h,
          area.x + l[2] * area.w,
          area.y + l[3] * area.h
        );
      }

      noStroke();
      fill("#3b2d3a");
      textAlign(LEFT, TOP);
      textSize(20);
      text("Cat & Mice Maze", 20, 18);
      textSize(12);
      text("Move with Arrow Keys / WASD through the cartoon maze.", 20, 44);
    }

    function drawPlayers(roomState, players, myId) {
      function displayRole(socketId, info) {
        if (info?.role === "cat" || info?.role === "mouse") return info.role;
        if (!localRoleFallback[socketId]) {
          localRoleFallback[socketId] = Math.random() < 0.5 ? "cat" : "mouse";
        }
        return localRoleFallback[socketId];
      }

      function drawOnePlayer(socketId, info, px, py, isMe) {
        const roleText = displayRole(socketId, info);
        const color = info.caught ? "#b3aebd" : roleColor(info.role, isMe);

        noStroke();
        fill(color);
        circle(px, py, 52);

        stroke("#3b2d3a");
        strokeWeight(3);
        noFill();
        circle(px, py, 52);

        if (isMe) {
          noStroke();
          fill("#1f1a27");
          circle(px, py, 10);
        }

        noStroke();
        fill("#2b2233");
        textAlign(CENTER, CENTER);
        textSize(10);
        text(info.caught ? "game over" : roleText, px, py + 36);
      }

      const seats = roomState?.seats || [];
      let shown = 0;
      let meShown = false;
      for (const seat of seats) {
        if (!seat || seat.empty || !seat.socketId) continue;
        const anchor = seatAnchors[seat.index] || { x: 0.5, y: 0.5 };
        if (!anchor) continue;

        const info = players?.[seat.socketId] || {};
        const px = Number.isFinite(info.x) ? info.x * width : anchor.x * width;
        const py = Number.isFinite(info.y) ? info.y * height : anchor.y * height;
        const isMe = seat.socketId === myId;
        drawOnePlayer(seat.socketId, info, px, py, isMe);
        if (isMe) meShown = true;
        shown += 1;
      }

      // Fallback: if player is not seated, still render local controllable token.
      if (!meShown && myId && players?.[myId]) {
        const me = players[myId];
        const px = Number.isFinite(me.x) ? me.x * width : width * 0.5;
        const py = Number.isFinite(me.y) ? me.y * height : height * 0.5;
        drawOnePlayer(myId, me, px, py, true);
        shown += 1;
      }

      if (shown === 0) {
        fill("#2b2233");
        textAlign(CENTER, CENTER);
        textSize(18);
        text("No seated players yet", width / 2, height / 2);
      }
    }

    return {
      draw(state) {
        drawBaseMap();
        drawPlayers(state?.roomState, state?.players, state?.myId);
      }
    };
  }

  root.appMapScene = { create };
})();
