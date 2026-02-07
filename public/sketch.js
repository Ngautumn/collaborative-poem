let my = { lat:null, lng:null, accuracy:null, heading:0 };
let center = null;

const metersPerDegLat = 111320;
let metersSmooth = {dx:0,dy:0};
const SCALE = 0.9;

let watchId = null;
let controlsBound = false;
let gameStarted = false;
let isHost = false;
let selectedHostSeat = null;
let sceneTheme = {
  bg: "#0b0f14",
  grid: "#505050",
  text: "#ffffff",
  triangle: "#508cff"
};

// HUD  HUD retch
const statusEl = () => document.getElementById("status");
const accEl = () => document.getElementById("acc");
const coordEl = () => document.getElementById("coord");
const metersEl = () => document.getElementById("meters");
const hostBtnEl = () => document.getElementById("hostBtn");
const seatEls = () => Array.from(document.querySelectorAll(".seat"));

function setScene(mode) {
  gameStarted = mode === "game";
  document.body.classList.toggle("scene-cover", !gameStarted);
  document.body.classList.toggle("scene-game", gameStarted);
}

function loadSceneTheme() {
  const rootStyle = getComputedStyle(document.documentElement);
  sceneTheme = {
    bg: (rootStyle.getPropertyValue("--scene-bg") || "#0b0f14").trim(),
    grid: (rootStyle.getPropertyValue("--scene-grid") || "#505050").trim(),
    text: (rootStyle.getPropertyValue("--scene-text") || "#ffffff").trim(),
    triangle: (rootStyle.getPropertyValue("--scene-triangle") || "#508cff").trim()
  };
}

function bindControls() {
  if (controlsBound) return;
  controlsBound = true;

  const hostBtn = hostBtnEl();
  const startBtn = document.getElementById("startgps");
  const seats = seatEls();

  if (hostBtn) {
    hostBtn.type = "button";
    hostBtn.disabled = false;
    hostBtn.textContent = "Become Host";
    hostBtn.onclick = () => {
      isHost = true;
      selectedHostSeat = 1;
      hostBtn.textContent = "Host: Seat 1";
      seats.forEach((seat, idx) => {
        seat.classList.remove("host-ready");
        seat.classList.remove("occupied");
        seat.textContent = idx === 0 ? "Seat 1 (Host Occupied)" : `Seat ${idx + 1}`;
      });
      if (seats[0]) {
        seats[0].classList.add("occupied");
      }
      if (startBtn) startBtn.disabled = false;
      const s = statusEl();
      if (s) s.textContent = "Host Occupied at Seat 1";
    };
  }

  seats.forEach((seat, idx) => {
    seat.onclick = () => {
      if (!isHost) return;
      selectedHostSeat = idx + 1;
      seats.forEach((s, i) => {
        s.classList.remove("host-ready");
        s.classList.toggle("occupied", i === idx);
        s.textContent = i === idx ? `Seat ${i + 1} (Host Occupied)` : `Seat ${i + 1}`;
      });
      if (startBtn) startBtn.disabled = false;
      if (hostBtn) hostBtn.textContent = `Host: Seat ${selectedHostSeat}`;
      const s = statusEl();
      if (s) s.textContent = `Host Occupied at Seat ${selectedHostSeat}`;
    };
  });

  if (startBtn) {
    startBtn.type = "button";
    startBtn.disabled = true;
    startBtn.textContent = "Start game";
    startBtn.onclick = () => {
      if (!isHost || selectedHostSeat === null) return;
      setScene("game");
      startBtn.textContent = "In game";
      const s = statusEl();
      if (s) s.textContent = "In Game Scene";
    };
  }

  const recenterBtn = document.getElementById("recenter");
  if (recenterBtn) {
    recenterBtn.type = "button";
    recenterBtn.disabled = true;
    recenterBtn.onclick = null;
  }

  const s = statusEl();
  if (s) s.textContent = "Cover Scene (select host and seat first)";
}

function setup(){
  const c = createCanvas(window.innerWidth, window.innerHeight);
  c.style("pointer-events", "none");
  loadSceneTheme();
  setScene("cover");
  bindControls();
}

function draw(){
  if (!gameStarted) {
    background(sceneTheme.bg);
    fill(18, 24, 34, 180);
    noStroke();
    rectMode(CENTER);
    rect(width / 2, height / 2, Math.min(620, width - 60), 240, 20);
    rectMode(CORNER);
    noStroke();
    fill(sceneTheme.text);
    textSize(34);
    textAlign(CENTER, CENTER);
    text("COVER", width / 2, height / 2 - 52);
    textSize(18);
    text("Cat & Mouse", width / 2, height / 2 - 14);
    textSize(14);
    text("Press Start game to enter the GPS stage", width / 2, height / 2 + 24);
    text("This is the cover scene", width / 2, height / 2 + 48);
    return;
  }

  background(sceneTheme.bg);

  // 雷达 UI
  stroke(sceneTheme.grid);
  noFill();
  circle(width/2, height/2, 300);
  circle(width/2, height/2, 600);
  line(width/2-2000, height/2, width/2+2000, height/2);
  line(width/2, height/2-2000, width/2, height/2+2000);

  fill(sceneTheme.text);
  noStroke();
  textSize(16);
  textAlign(LEFT, BASELINE);
  text("IN GAME - GPS TRIANGLE",20,height-20);

  if(my.lat==null){
    // 没坐标就不画三角形
    return;
  }

  if(!center) center = {lat:my.lat, lng:my.lng};

  const metersPerDegLng = 111320 * Math.cos(my.lat * Math.PI/180);

  let dx = (my.lng-center.lng)*metersPerDegLng;
  let dy = (my.lat-center.lat)*metersPerDegLat;

  // 平滑
  metersSmooth.dx += (dx-metersSmooth.dx)*0.2;
  metersSmooth.dy += (dy-metersSmooth.dy)*0.2;

  let x = width/2 + metersSmooth.dx*SCALE;
  let y = height/2 - metersSmooth.dy*SCALE;

  drawTriangle(x,y,my.heading);
}

function drawTriangle(x,y,heading){
  push();
  translate(x,y);
  rotate(radians(heading || 0));
  noStroke();
  fill(sceneTheme.triangle);
  triangle(0,-14,-10,10,10,10);
  pop();
}

function windowResized(){
  resizeCanvas(window.innerWidth, window.innerHeight);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindControls, { once: true });
} else {
  bindControls();
}
