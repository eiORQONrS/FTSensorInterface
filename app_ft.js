window.addEventListener('DOMContentLoaded', () => {
  /***********************
   * Config
   ***********************/
  const WS_URL      = "ws://127.0.0.1:8765";
  const WINDOW_SEC  = 5;
  const DRAW_FPS    = 60;
  const MAX_SAMPLES = 6000;

  const CHS   = ["Fx","Fy","Fz","Tx","Ty","Tz"];
  const ORDER = ["Fy","Fx","Fz","Tx","Ty","Tz"];
  const UNITS = { Fx:"N", Fy:"N", Fz:"N", Tx:"Nm", Ty:"Nm", Tz:"Nm" };

  const FZ_SIGN = -1;

  const DEFAULT_ACTIVE = { Fy:true, Fx:true, Fz:true, Tx:false, Ty:false, Tz:false };

  const DEFAULT_CFG = {
    Fx:{min:-8, max: 8, step:2},
    Fy:{min:-8, max: 8, step:2},
    Fz:{min:-8, max: 8, step:2},
    Tx:{min:-16, max: 16, step:4},
    Ty:{min:-16, max: 16, step:4},
    Tz:{min:-16, max: 16, step:4},
  };

  const LS_ACTIVE = "ft_active_channels_v4";
  const LS_CFG    = "ft_axis_cfg_v4";

  const YPAD = 8;
  const LABEL_Y_NUDGE = -8;

  /***********************
   * DOM
   ***********************/
  const valLine = document.getElementById("valLine");
  const rxPill  = document.getElementById("rxPill");

  const cfgBtn  = document.getElementById("cfgBtn");
  const chanBtns = [...document.querySelectorAll(".chanBtn[data-ch]")];

  const recBtn  = document.getElementById("recBtn");
  const dirBtn  = document.getElementById("dirBtn");

  const wsDot   = document.getElementById("wsDot");
  const wsText  = document.getElementById("wsText");

  const plotsRow = document.getElementById("plotsRow");

  const cfgModal = document.getElementById("cfgModal");
  const cfgBackdrop = document.getElementById("cfgBackdrop");
  const cfgGrid  = document.getElementById("cfgGrid");
  const cfgError = document.getElementById("cfgError");
  const cfgResetBtn = document.getElementById("cfgResetBtn");
  const cfgApplyBtn = document.getElementById("cfgApplyBtn");

  const canv = {
    Fx: document.getElementById("fxCanvas"),
    Fy: document.getElementById("fyCanvas"),
    Fz: document.getElementById("fzCanvas"),
    Tx: document.getElementById("txCanvas"),
    Ty: document.getElementById("tyCanvas"),
    Tz: document.getElementById("tzCanvas"),
  };
  const yLabs = {
    Fx: document.getElementById("fxY"),
    Fy: document.getElementById("fyY"),
    Fz: document.getElementById("fzY"),
    Tx: document.getElementById("txY"),
    Ty: document.getElementById("tyY"),
    Tz: document.getElementById("tzY"),
  };

  /***********************
   * State
   ***********************/
  let active = loadJSON(LS_ACTIVE, DEFAULT_ACTIVE);
  let axisCfg = loadJSON(LS_CFG, DEFAULT_CFG);

  let lastVals = { Fx:0, Fy:0, Fz:0, Tx:0, Ty:0, Tz:0 };

  /***********************
   * Buttons (grey/green)
   ***********************/
  const btnMap = {};
  for (const b of chanBtns){
    const ch = b.getAttribute("data-ch");
    if (!ch) continue;
    btnMap[ch] = b;
    b.addEventListener("click", () => {
      active[ch] = !active[ch];
      saveJSON(LS_ACTIVE, active);
      syncButtons();
      applyPanelVisibility();
      updateValLine(lastVals);
      resizeAll();
    });
  }
  function syncButtons(){
    for (const ch of CHS){
      btnMap[ch]?.classList.toggle("on", !!active[ch]);
    }
  }
  syncButtons();

  function applyPanelVisibility(){
    for (const ch of CHS){
      const p = plotsRow?.querySelector(`.panel[data-panel="${ch}"]`);
      if (p) p.style.display = active[ch] ? "" : "none";
    }
  }
  applyPanelVisibility();

  /***********************
   * WS status
   ***********************/
  function setWS(ok){
    wsDot?.classList.toggle("ok", ok);
    if (wsText) wsText.textContent = ok ? "Connected" : "Disconnected";
  }

  /***********************
   * Rx: ONLY "xxx Hz"
   ***********************/
  let rxTimes = [];
  function updateHz(){
    const nowSec = performance.now()/1000;
    const cutoff = nowSec - 1.0;
    while (rxTimes.length && rxTimes[0] < cutoff) rxTimes.shift();
    if (rxPill) rxPill.textContent = `${Math.round(rxTimes.length)} Hz`;
  }
  function pushRx(){
    rxTimes.push(performance.now()/1000);
    updateHz();
  }
  setInterval(updateHz, 250);

  /***********************
   * Top numbers (stable sign)
   ***********************/
  const signState = { Fx:+1, Fy:+1, Fz:+1, Tx:+1, Ty:+1, Tz:+1 };
  const EPS_SIGN  = 0.003;

  function stableSign(value, key){
    const prev = signState[key] ?? +1;
    const next = (value >  EPS_SIGN) ? +1 :
                 (value < -EPS_SIGN) ? -1 : prev;
    signState[key] = next;
    const shown = (Math.abs(value) < 0.0005) ? 0 : value;
    return { sign: next, value: shown };
  }
  function fmtSignedStable(x, key, intWidth=2){
    const { sign, value } = stableSign(x, key);
    const abs = Math.abs(value).toFixed(3);
    const [i, f] = abs.split(".");
    return (sign>0?"+":"-") + i.padStart(intWidth,"0") + "." + f;
  }
  function updateValLine(vals){
    if (!valLine) return;
    const parts = [];
    for (const ch of ORDER){
      if (!active[ch]) continue;
      const v = vals[ch] ?? 0;
      const cfg = axisCfg[ch] ?? DEFAULT_CFG[ch];
      const intW = (Math.max(Math.abs(cfg.min), Math.abs(cfg.max)) >= 100) ? 3 : 2;
      parts.push(`${ch}: ${fmtSignedStable(v, ch, intW)}`);
    }
    valLine.textContent = parts.length ? parts.join("  ") : "No channels selected";
  }
  updateValLine(lastVals);

  /***********************
   * Directory + Record (robust)
   ***********************/
  let dirHandle = null;

  function updateDirLabel(){
    if (!dirBtn) return;
    const labelEl = dirBtn.querySelector('.label');
    const text = dirHandle ? dirHandle.name : 'Select folder';
    if (labelEl) labelEl.textContent = text;
    else dirBtn.textContent = text;
  }

  async function pickDirectoryIfNeeded(){
    if (dirHandle) return true;
    if (!window.showDirectoryPicker){
      alert("Folder picker not supported here. Open via http://127.0.0.1:8000/ in Chrome (not file://).");
      return false;
    }
    try{
      dirHandle = await window.showDirectoryPicker({ id:'haptics-log-dir', mode:'readwrite' });
      updateDirLabel();
      return true;
    }catch(e){
      console.warn("Directory picker canceled:", e);
      return false;
    }
  }
  dirBtn?.addEventListener("click", async ()=>{ await pickDirectoryIfNeeded(); });

  const recorder = { active:false, tStart:0, rows:[] };

  function nowTS(){
    const d = new Date();
    const pad = (n)=> String(n).padStart(2,'0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }
  async function saveCSVToDir(handle, filename, rows){
    const csv = rows.map(r => r.join(",")).join("\n");
    const fileHandle = await handle.getFileHandle(filename, { create:true });
    const writable = await fileHandle.createWritable();
    await writable.write(csv);
    await writable.close();
  }
  async function stopAndSave(){
    const ts = nowTS();
    if (!dirHandle){
      const ok = await pickDirectoryIfNeeded();
      if (!ok) return;
    }
    if (recorder.rows.length > 1){
      await saveCSVToDir(dirHandle, `daq_${ts}.csv`, recorder.rows);
    }
  }
  async function toggleRecord(){
    if (!recorder.active){
      const ok = await pickDirectoryIfNeeded();
      if (!ok) return;
      recorder.active = true;
      recBtn?.classList.add("on");
      recorder.tStart = performance.now()/1000;
      recorder.rows = [["time","Fx","Fy","Fz","Tx","Ty","Tz"]];
    } else {
      recorder.active = false;
      recBtn?.classList.remove("on");
      await stopAndSave();
    }
  }
  recBtn?.addEventListener("click", ()=>{ toggleRecord(); });

  /***********************
   * Buffers
   ***********************/
  const tBuf = new Float64Array(MAX_SAMPLES);
  const bufs = {};
  for (const ch of CHS) bufs[ch] = new Float32Array(MAX_SAMPLES);
  let wp = 0, filled = 0;

  /***********************
   * Canvas resizing
   ***********************/
  const ctxs = {};
  function resizeCanvasToCSSPixelSize(canvas){
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = Math.max(1, Math.round(rect.width  * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr,0,0,dpr,0,0);
    return ctx;
  }
  function resizeAll(){
    for (const ch of CHS){
      if (!active[ch]) continue;
      const c = canv[ch];
      if (!c) continue;
      ctxs[ch] = resizeCanvasToCSSPixelSize(c);
    }
    placeAllYLabels();
  }
  window.addEventListener("resize", resizeAll);
  resizeAll();

  /***********************
   * Y ticks / labels
   ***********************/
  function yToPx(val, yMin, yMax, canvasHeight){
    const H = canvasHeight - YPAD*2;
    return Math.round(canvasHeight - YPAD - (val - yMin) * (H / (yMax - yMin)));
  }
  function ticksFromRange(min, max, step){
    const out = [];
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0) return out;
    if (max === min) return [min];
    const eps = step * 1e-6;
    const start = Math.ceil((min - eps) / step) * step;
    const dec = Math.min(6, Math.max(0, (step.toString().split(".")[1] || "").length));
    for (let v = start; v <= max + eps; v += step) out.push(+v.toFixed(dec));
    return out;
  }
  function setYLabelsAbs(container, ticks, unit, canvas, yMin, yMax){
    if (!container || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    container.innerHTML = "";
    for (const v of ticks){
      const ypx = yToPx(v, yMin, yMax, rect.height) + LABEL_Y_NUDGE;
      const d = document.createElement("div");
      d.className = "ytick";
      d.style.top = `${ypx}px`;
      d.textContent = unit ? `${v} ${unit}` : `${v}`;
      container.appendChild(d);
    }
  }
  function placeAllYLabels(){
    for (const ch of CHS){
      if (!active[ch]) continue;
      const cfg = axisCfg[ch] ?? DEFAULT_CFG[ch];
      const ticks = ticksFromRange(cfg.min, cfg.max, cfg.step);
      setYLabelsAbs(yLabs[ch], ticks, UNITS[ch], canv[ch], cfg.min, cfg.max);
    }
  }

  /***********************
   * Drawing
   ***********************/
  function drawTimeGrid(ctx, w, h){
    ctx.save();
    ctx.setLineDash([6,6]);
    ctx.strokeStyle = "#2a3142";
    ctx.lineWidth = 1;
    for (let j = 0; j <= WINDOW_SEC; j++){
      const x = Math.round((j / WINDOW_SEC) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.restore();
  }
  function pickColor(ch){
    switch(ch){
      case "Fz": return "#7bd389";
      case "Fx": return "#6ea8fe";
      case "Fy": return "#f7b267";
      case "Tx": return "#c77dff";
      case "Ty": return "#4dd4ff";
      case "Tz": return "#ff6b6b";
      default:   return "#6ea8fe";
    }
  }
  function drawSeries(ctx, arr, color, idxFrom, count, tStart, tEnd, yMin, yMax){
    const rect = ctx.canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;

    const totalT = Math.max(1e-6, tEnd - tStart);
    const H = h - YPAD*2;
    const yScale = (v)=> h - YPAD - (v - yMin) * (H / (yMax - yMin));

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    let started = false;
    let prevCol = null;

    for (let k=0; k<count; k++){
      const i = (idxFrom + k) % MAX_SAMPLES;
      const tt = tBuf[i];
      if (tt < tStart) continue;

      const x = ((tt - tStart) / totalT) * w;
      const v = arr[i];
      if (!Number.isFinite(v)) continue;

      const y = yScale(v);
      const col = Math.floor(x);
      if (prevCol !== null && col === prevCol) continue;
      prevCol = col;

      if (!started){ ctx.moveTo(x,y); started = true; }
      else ctx.lineTo(x,y);
    }

    ctx.stroke();
    ctx.restore();
  }
  function drawAll(){
    if (filled === 0){
      placeAllYLabels();
      return;
    }

    const endIdx = (wp - 1 + MAX_SAMPLES) % MAX_SAMPLES;
    const tEnd = tBuf[endIdx];
    const tStart = tEnd - WINDOW_SEC;

    let count = Math.min(filled, MAX_SAMPLES);
    let idxFrom = (wp - count + MAX_SAMPLES) % MAX_SAMPLES;

    while (count > 1 && tBuf[idxFrom] < tStart){
      idxFrom = (idxFrom + 1) % MAX_SAMPLES;
      count--;
    }

    for (const ch of CHS){
      if (!active[ch]) continue;
      const ctx = ctxs[ch];
      const canvas = canv[ch];
      if (!ctx || !canvas) continue;

      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0,0,rect.width,rect.height);

      drawTimeGrid(ctx, rect.width, rect.height);

      const cfg = axisCfg[ch] ?? DEFAULT_CFG[ch];
      const ticks = ticksFromRange(cfg.min, cfg.max, cfg.step);
      setYLabelsAbs(yLabs[ch], ticks, UNITS[ch], canvas, cfg.min, cfg.max);

      ctx.save();
      ctx.setLineDash([6,6]);
      ctx.strokeStyle = "#2a3142";
      ctx.lineWidth = 1;
      for (const v of ticks){
        const y = yToPx(v, cfg.min, cfg.max, rect.height) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(rect.width, y); ctx.stroke();
      }
      ctx.restore();

      drawSeries(ctx, bufs[ch], pickColor(ch), idxFrom, count, tStart, tEnd, cfg.min, cfg.max);
    }
  }
  let lastDraw = 0;
  function loop(ts){
    if (ts - lastDraw > (1000 / DRAW_FPS)){
      drawAll();
      lastDraw = ts;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /***********************
   * WebSocket
   ***********************/
  let ws;
  let t0s = null, t0c = null, lastT = -Infinity;

  function onWS(ev){
    const d = JSON.parse(ev.data);
    pushRx();

    if (t0s === null && typeof d.t === "number"){
      t0s = d.t;
      t0c = performance.now()/1000;
    }
    let t = (typeof d.t === "number" && t0s !== null) ? (t0c + (d.t - t0s)) : (performance.now()/1000);
    if (t <= lastT) t = lastT + 1e-6;
    lastT = t;

    const Fx = d.Fx ?? 0;
    const Fy = d.Fy ?? 0;
    const Fz = FZ_SIGN * (d.Fz ?? 0);
    const Tx = d.Tx ?? 0;
    const Ty = d.Ty ?? 0;
    const Tz = d.Tz ?? 0;

    lastVals = { Fx, Fy, Fz, Tx, Ty, Tz };

    tBuf[wp] = t;
    bufs.Fx[wp] = Fx;
    bufs.Fy[wp] = Fy;
    bufs.Fz[wp] = Fz;
    bufs.Tx[wp] = Tx;
    bufs.Ty[wp] = Ty;
    bufs.Tz[wp] = Tz;

    wp = (wp + 1) % MAX_SAMPLES;
    if (filled < MAX_SAMPLES) filled++;

    updateValLine(lastVals);

    if (recorder.active){
      const tRel = (performance.now()/1000) - recorder.tStart;
      recorder.rows.push([
        tRel.toFixed(6),
        Fx.toFixed(6), Fy.toFixed(6), Fz.toFixed(6),
        Tx.toFixed(6), Ty.toFixed(6), Tz.toFixed(6),
      ]);
    }
  }

  function connectWS(){
    ws = new WebSocket(WS_URL);
    ws.onopen = ()=> setWS(true);
    ws.onclose = ()=> setWS(false);
    ws.onerror = ()=> setWS(false);
    ws.onmessage = onWS;
  }
  connectWS();

  /***********************
   * Configuration modal:
   * - Only Reset & Apply on top
   * - Insert a shallow divider after Fz row
   ***********************/
  let cfgDraft = deepClone(axisCfg);

  function openCfg(){
    cfgDraft = deepClone(axisCfg);
    renderCfgGrid();
    hideCfgError();
    cfgModal?.classList.add("show");
    cfgModal?.setAttribute("aria-hidden","false");
  }
  function closeCfg(){
    cfgModal?.classList.remove("show");
    cfgModal?.setAttribute("aria-hidden","true");
  }

  function renderCfgGrid(){
    if (!cfgGrid) return;
    cfgGrid.innerHTML = "";

    for (const ch of CHS){
      const c = cfgDraft[ch] ?? deepClone(DEFAULT_CFG[ch]);
      cfgDraft[ch] = c;

      cfgGrid.appendChild(makeChanCell(ch));
      cfgGrid.appendChild(makeCfgInput(ch, "min",  c.min));
      cfgGrid.appendChild(makeCfgInput(ch, "max",  c.max));
      cfgGrid.appendChild(makeCfgInput(ch, "step", c.step));

      // divider after the 3 forces
      if (ch === "Fz"){
        const div = document.createElement("div");
        div.className = "cfgDivider";
        cfgGrid.appendChild(div);
      }
    }
  }

  function makeChanCell(ch){
    const d = document.createElement("div");
    d.className = "cfgChan";
    d.textContent = ch;
    return d;
  }

  function makeCfgInput(ch, key, val){
    const inp = document.createElement("input");
    inp.className = "cfgInput";
    inp.type = "text";
    inp.inputMode = "decimal";
    inp.value = String(val);
    inp.addEventListener("input", () => {
      cfgDraft[ch][key] = parseFloat(inp.value);
    });
    return inp;
  }

  function validateCfg(cfg){
    for (const ch of CHS){
      const c = cfg[ch];
      if (!c) return `Missing config for ${ch}`;
      const {min, max, step} = c;

      if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step))
        return `${ch}: Min/Max/Step must be numbers`;

      if (max <= min) return `${ch}: Max must be > Min`;
      if (step <= 0)  return `${ch}: Step must be > 0`;

      const nTicks = Math.floor((max - min)/step) + 1;
      if (nTicks > 2000) return `${ch}: too many ticks (increase Step)`;
    }
    return null;
  }

  function showCfgError(msg){
    if (!cfgError) return;
    cfgError.style.display = "";
    cfgError.textContent = msg;
  }
  function hideCfgError(){
    if (!cfgError) return;
    cfgError.style.display = "none";
    cfgError.textContent = "";
  }

  cfgBtn?.addEventListener("click", openCfg);
  cfgBackdrop?.addEventListener("click", closeCfg);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && cfgModal?.classList.contains("show")) closeCfg();
  });

  cfgResetBtn?.addEventListener("click", () => {
    cfgDraft = deepClone(DEFAULT_CFG);
    renderCfgGrid();
    hideCfgError();
  });

  cfgApplyBtn?.addEventListener("click", () => {
    const err = validateCfg(cfgDraft);
    if (err){ showCfgError(err); return; }

    axisCfg = deepClone(cfgDraft);
    saveJSON(LS_CFG, axisCfg);

    updateValLine(lastVals);
    resizeAll();
    closeCfg();
  });

  /***********************
   * Utils
   ***********************/
  function deepClone(x){ return JSON.parse(JSON.stringify(x)); }
  function loadJSON(key, fallback){
    try{
      const s = localStorage.getItem(key);
      if (!s) return deepClone(fallback);
      const v = JSON.parse(s);
      return Object.assign(deepClone(fallback), v);
    }catch(_){
      return deepClone(fallback);
    }
  }
  function saveJSON(key, obj){
    try{ localStorage.setItem(key, JSON.stringify(obj)); }catch(_){}
  }
});