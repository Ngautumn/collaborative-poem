let my = { lat:null, lng:null, accuracy:null, heading:0 };
let center = null;

const metersPerDegLat = 111320;
let metersSmooth = {dx:0,dy:0};
const SCALE = 0.9;

let watchId = null;

// HUD
const statusEl = () => document.getElementById("status");
const accEl = () => document.getElementById("acc");
const coordEl = () => document.getElementById("coord");
const metersEl = () => document.getElementById("meters");

function setup(){
  createCanvas(window.innerWidth, window.innerHeight);

  // iOS 友好：必须用户点击后才开始定位
  const startBtn = document.getElementById("startgps");
  if (startBtn){
    startBtn.addEventListener("click", () => {
      startBtn.disabled = true;
      startBtn.textContent = "定位中…";
      startGPS();
    });
  }

  const recenterBtn = document.getElementById("recenter");
  if (recenterBtn){
    recenterBtn.addEventListener("click", () => {
      if (my.lat == null) return;
      center = {lat: my.lat, lng: my.lng};
      metersSmooth = {dx:0, dy:0};
      statusEl().textContent = "状态：已重置中心点";
    });
  }

  statusEl().textContent = "状态：点『开始定位』";
}

function draw(){
  background(10);

  // 雷达 UI
  stroke(80);
  noFill();
  circle(width/2, height/2, 300);
  circle(width/2, height/2, 600);
  line(width/2-2000, height/2, width/2+2000, height/2);
  line(width/2, height/2-2000, width/2, height/2+2000);

  fill(255);
  noStroke();
  textSize(14);
  text("GPS TRIANGLE",20,height-20);

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
  fill(80,140,255);
  triangle(0,-14,-10,10,10,10);
  pop();
}

function startGPS(){
  if(!navigator.geolocation){
    statusEl().textContent = "状态：此设备不支持定位";
    return;
  }

  // 显示权限状态（iOS 也适用）
  if (navigator.permissions && navigator.permissions.query){
    navigator.permissions.query({ name: "geolocation" }).then(p=>{
      statusEl().textContent = `状态：权限 ${p.state}，正在请求定位…`;
    }).catch(()=>{});
  } else {
    statusEl().textContent = "状态：正在请求定位…";
  }

  // 注意：iOS 需要 HTTPS（你现在是 trycloudflare 的 https，OK）
  watchId = navigator.geolocation.watchPosition(
    (pos)=>{
      my.lat = pos.coords.latitude;
      my.lng = pos.coords.longitude;
      my.accuracy = pos.coords.accuracy;

      // heading 常为 null，不强求
      if (pos.coords.heading != null && !Number.isNaN(pos.coords.heading)){
        my.heading = pos.coords.heading;
      }

      // HUD 更新
      statusEl().textContent = "状态：定位成功 ✅";
      accEl().textContent = "精度：" + (my.accuracy ? my.accuracy.toFixed(1)+"m" : "—");
      coordEl().textContent = `lat/lng：${my.lat.toFixed(6)}, ${my.lng.toFixed(6)}`;

      if (center){
        metersEl().textContent = `dx/dy：${metersSmooth.dx.toFixed(1)}m, ${metersSmooth.dy.toFixed(1)}m`;
      } else {
        metersEl().textContent = `dx/dy：—`;
      }
    },
    (err)=>{
      // 把错误直接显示出来（你就能知道到底被什么拦了）
      statusEl().textContent = `状态：定位失败 ❌ (${err.code}) ${err.message}`;
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000
    }
  );
}

function windowResized(){
  resizeCanvas(window.innerWidth, window.innerHeight);
}
