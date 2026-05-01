const API_BASE_URL = "https://plan-bu-backend.hdbdt1597-cloudflare.workers.dev";
const SITE_SLUG = "bua-st-serge";

const MIN_HOUR = 8, MAX_HOUR = 22;
const nowH = new Date().getHours();

let LOCATIONS = {};
let AVAILABILITY = {};
let SEATS = []; 
let mapImage = new Image();
let mapBaseHeight = 1600; 

let hoveredSeatId = null;
let isFetchingData = true;

const els = {
    dp: document.getElementById('datePicker'),
    toast: document.getElementById('toast'),
    slider: document.getElementById('slider'),
    btnReload: document.getElementById('btnReload'),
    lastUpdate: document.getElementById('lastUpdate'),
    fill: document.getElementById('fill'),
    thS: document.getElementById('thS'),
    thE: document.getElementById('thE'),
    lblStart: document.getElementById('lblStart'),
    lblEnd: document.getElementById('lblEnd'),
    nowMarker: document.getElementById('nowMarker'),
    viewport: document.getElementById('viewport'),
    actionBar: document.getElementById('actionBar'),
    barTitle: document.getElementById('barTitle'),
    barAvailability: document.getElementById('barAvailability'),
    barAmenities: document.getElementById('barAmenities'),
    btnCloseAction: document.getElementById('btnCloseAction'),
    btnBook: document.getElementById('btnBook'),
    btnOpenLegend: document.getElementById('btnOpenLegend'),
    btnCloseLegend: document.getElementById('btnCloseLegend'),
    legendModal: document.getElementById('legendModal')
};

const appState = new Proxy({
    startHour: Math.max(MIN_HOUR, Math.min(MAX_HOUR, nowH)),
    endHour: Math.max(MIN_HOUR, Math.min(MAX_HOUR, nowH + 2)),
    selectedSeatId: null
}, {
    set(target, prop, value) {
        if (target[prop] === value) return true;
        target[prop] = value;
        updateMapState();
        requestRender();
        return true;
    }
});

const canvas = document.getElementById('mapCanvas');
const ctx = canvas.getContext('2d', { alpha: false }); 
const tooltip = document.getElementById('canvasTooltip');

let mapState = { x: 0, y: 0, scale: 1 };
let dpr = window.devicePixelRatio || 1;

const C_BG = '#f8fafc';
const C_UNKNOWN = '#cbd5e1';
const C_BUSY = '#64748b';
const C_FREE = 'rgba(16, 185, 129, 0.8)';
const C_BORDER = 'rgba(255, 255, 255, 0.4)';
const C_SELECT = '#ffffff';
const C_PLUG = '#3b82f6';
const C_LIGHT = 'rgba(253, 224, 71, 0.4)';

function updateActionBarUI() {
    if (!appState.selectedSeatId) {
        els.actionBar.classList.remove('visible');
        return;
    }
    const clickedSeat = SEATS.find(s => s.id === appState.selectedSeatId);
    if (!clickedSeat) return;

    els.barTitle.innerText = "Place " + clickedSeat.id;
    
    let availHtml = '';
    let btnClass = '';
    let btnText = '';

    if (clickedSeat.state === 'free') {
        availHtml = `<span style="color: #10b981;">Place libre</span>`;
        btnClass = 'btn-primary';
        btnText = 'Réserver maintenant';
    } else if (clickedSeat.state === 'busy') {
        availHtml = `<span style="color: #ef4444;">Place occupée</span>`;
        btnClass = 'btn-secondary';
        btnText = 'Voir les disponibilités';
    } else {
        availHtml = `<span style="color: #94a3b8;">Données inconnues</span>`;
        btnClass = 'btn-disabled';
        btnText = 'Indisponible';
    }
    
    els.barAvailability.innerHTML = availHtml;

    let iconsHtml = '';
    if (clickedSeat.hasPlug) {
        iconsHtml += `<svg style="width:18px;height:18px;color:var(--plug-color);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="12" height="10" x="6" y="6" rx="2"/><path d="M12 16v6"/></svg>`;
    }
    if (clickedSeat.hasLight) {
        iconsHtml += `<svg style="width:18px;height:18px;color:#eab308;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2h8l4 10H4L8 2Z"/><path d="M12 12v6"/><path d="M8 22h8"/></svg>`;
    }

    if (iconsHtml !== '') {
        els.barAmenities.innerHTML = `<span style="color:#cbd5e1;">|</span>` + iconsHtml;
    } else {
        els.barAmenities.innerHTML = '';
    }

    els.btnBook.className = `action-btn ${btnClass}`;
    els.btnBook.innerText = btnText;

    els.actionBar.classList.add('visible');
}

/**
 * Loads the image from local path or cache
 */
async function fetchImageWithCache(url) {
    return new Promise(async (resolve) => {
        const cacheName = 'bu-map-img-v3'; // Bumped version for assets/ folder
        try {
            const cache = await caches.open(cacheName);
            const cachedRes = await cache.match(url);
            if (cachedRes) {
                const blob = await cachedRes.blob();
                mapImage.src = URL.createObjectURL(blob);
                mapImage.onload = () => resolve();
                fetch(url).then(res => { if (res.ok) cache.put(url, res.clone()); }).catch(() => {});
            } else {
                mapImage.src = url;
                mapImage.onload = () => resolve();
                fetch(url).then(res => { if (res.ok) cache.put(url, res.clone()); }).catch(() => {});
            }
        } catch (e) {
            mapImage.src = url;
            mapImage.onload = () => resolve();
        }
    });
}

async function loadConfig() {
    const cachedConfig = localStorage.getItem('bu_config_cache');
    if (cachedConfig) {
        try {
            LOCATIONS = JSON.parse(cachedConfig);
            buildHitGrid();
            requestRender();
        } catch (e) {}
    }
    
    try {
        const res = await fetch(`${API_BASE_URL}/api/config`);
        const freshConfig = await res.json();
        const freshString = JSON.stringify(freshConfig);
        
        if (cachedConfig !== freshString) {
            LOCATIONS = freshConfig;
            localStorage.setItem('bu_config_cache', freshString);
            buildHitGrid();
            updateMapState();
            requestRender();
        }
    } catch (e) {
        if (!cachedConfig) showToast("Erreur config", true);
    }
}

async function init() {
    resizeCanvas();
    window.addEventListener('resize', () => { resizeCanvas(); requestRender(); });

    const today = new Date();
    for (let i = 0; i < 4; i++) {
        let d = new Date(today);
        d.setDate(today.getDate() + i);
        const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        let t = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
        els.dp.add(new Option(t.charAt(0).toUpperCase() + t.slice(1), localDate));
    }

    // Load map from the assets folder
    await fetchImageWithCache('./assets/map.webp');
    mapBaseHeight = 1600 * (mapImage.naturalHeight / mapImage.naturalWidth);
    centerMap();

    await loadConfig();

    setupPointerEvents();
    setupSlider();
    setupLegendModal(); 
    
    els.btnCloseAction.addEventListener('click', () => {
        appState.selectedSeatId = null;
    });

    els.btnReload.addEventListener('click', () => {
        loadData(true);
        centerMap();
        requestRender();
    });

    els.dp.addEventListener('change', () => { 
        updateSliderUI(); 
        loadData(); 
        updateTimeMarker();
    });
    
    els.btnBook.addEventListener('click', () => { 
        if (appState.selectedSeatId && !els.btnBook.classList.contains('btn-disabled')) {
            openBooking(appState.selectedSeatId); 
        }
    });

    loadData();
    updateSliderUI();
    startAnimationLoop(); 
    
    updateTimeMarker();
    setInterval(updateTimeMarker, 60000);
}

function clampMap() {
    const viewW = els.viewport.clientWidth;
    const viewH = els.viewport.clientHeight;
    const cssMapW = 1600 * mapState.scale;
    const cssMapH = mapBaseHeight * mapState.scale;
    
    mapState.x = Math.max((viewW / 2) - cssMapW, Math.min(viewW / 2, mapState.x));
    mapState.y = Math.max((viewH / 2) - cssMapH, Math.min(viewH / 2, mapState.y));
}

function updateTimeMarker() {
    const now = new Date();
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
    if (els.dp.value === localToday) {
        const dec = now.getHours() + (now.getMinutes() / 60); 
        const start = MIN_HOUR + 0.5;
        if (dec >= start && dec <= (MAX_HOUR + 0.5)) { 
            els.nowMarker.style.left = (((dec - start) / (MAX_HOUR - MIN_HOUR)) * 100) + '%'; 
            els.nowMarker.style.display = 'block'; 
            return; 
        }
    } 
    els.nowMarker.style.display = 'none';
}

function drawDemo(type = 'default') {
    const dCanvas = document.getElementById('demoCanvas');
    const dCtx = dCanvas.getContext('2d');
    dCtx.clearRect(0, 0, 160, 160);

    const pad = 12, gap = 8, size = 64; 
    const boxWidth = (size * 2) + gap;

    if (type === 'light') {
        dCtx.fillStyle = C_LIGHT;
        dCtx.shadowColor = C_LIGHT;
        dCtx.shadowBlur = 20; 
        dCtx.fillRect(pad - 4, pad - 4, boxWidth + 8, boxWidth + 8);
        dCtx.shadowBlur = 0;
    }

    if (type === 'plug') {
        dCtx.strokeStyle = C_PLUG;
        dCtx.lineWidth = 6;
        dCtx.strokeRect(pad - 6, pad - 6, boxWidth + 12, boxWidth + 12);
    }

    const states = ['free', 'busy', 'busy', 'free'];
    if (type === 'unknown') states.fill('unknown');
    if (type === 'busy') states.fill('busy');
    if (type === 'free') states.fill('free');

    dCtx.lineWidth = 2;
    dCtx.strokeStyle = C_BORDER;

    for (let i = 0; i < 4; i++) {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = pad + col * (size + gap);
        const y = pad + row * (size + gap);

        let fill = C_UNKNOWN;
        if (states[i] === 'busy') fill = C_BUSY;
        if (states[i] === 'free') fill = C_FREE;

        dCtx.fillStyle = fill;
        dCtx.beginPath();
        dCtx.roundRect(x, y, size, size, 4);
        dCtx.fill();
        
        if (states[i] === 'free') {
            dCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            dCtx.stroke();
        } else {
            dCtx.strokeStyle = C_BORDER;
            dCtx.stroke();
        }
    }
}

function setupLegendModal() {
    els.btnOpenLegend.addEventListener('click', () => els.legendModal.classList.add('visible'));
    els.btnCloseLegend.addEventListener('click', () => els.legendModal.classList.remove('visible'));
    els.legendModal.addEventListener('click', (e) => {
        if (e.target === els.legendModal) els.legendModal.classList.remove('visible');
    });

    const interactives = document.querySelectorAll('.leg-interactive');
    drawDemo('default');

    interactives.forEach(item => {
        const type = item.dataset.type;
        item.addEventListener('pointerenter', () => drawDemo(type));
        item.addEventListener('pointerleave', () => drawDemo('default'));
        item.addEventListener('pointercancel', () => drawDemo('default'));
    });
}

function buildHitGrid() {
    SEATS = [];
    const BASE_W = 1600;
    const BASE_H = mapBaseHeight;

    Object.values(LOCATIONS).forEach(g => {
        let { id, ids: groupIds, start, end, direction = 'horizontal', label, layout, invert, x, y, w, h } = g;
        
        let ids = [];
        if (id) ids = [id.toString()];
        else if (groupIds) ids = [...groupIds];
        else if (start !== undefined && end !== undefined) {
            const c = parseInt(end) - parseInt(start) + 1;
            for (let i = 0; i < c; i++) ids.push((parseInt(start) + i).toString());
        } else return;

        if (ids.length === 0) return;

        const boxX = (x / 100) * BASE_W;
        const boxY = (y / 100) * BASE_H;
        const boxW = (w / 100) * BASE_W;
        const boxH = (h / 100) * BASE_H;

        const isDouble = layout === 'double';
        let cols = 1, rows = 1;
        
        if (direction === 'horizontal') {
            rows = isDouble ? 2 : 1; cols = isDouble ? Math.ceil(ids.length / 2) : ids.length;
        } else {
            cols = isDouble ? 2 : 1; rows = isDouble ? Math.ceil(ids.length / 2) : ids.length;
        }

        if (isDouble) {
            const m = Math.ceil(ids.length / 2);
            ids = invert ? [...ids.slice(m).reverse(), ...ids.slice(0, m)] : [...ids.slice(0, m), ...ids.slice(m).reverse()];
        } else if (invert) ids.reverse();

        const GAP = 2;
        const seatW = (boxW - (GAP * (cols - 1))) / cols;
        const seatH = (boxH - (GAP * (rows - 1))) / rows;

        ids.forEach((seatId, index) => {
            let col = direction === 'horizontal' ? (index % cols) : Math.floor(index / rows);
            let row = direction === 'horizontal' ? Math.floor(index / cols) : (index % rows);

            SEATS.push({
                id: seatId, boxStartId: ids[0], label: label || seatId,
                x: boxX + (col * (seatW + GAP)), y: boxY + (row * (seatH + GAP)), w: seatW, h: seatH,
                boxX: boxX, boxY: boxY, boxW: boxW, boxH: boxH, 
                state: 'skeleton', hasPlug: false, hasLight: false
            });
        });
    });
}

async function loadData(force = false) {
    isFetchingData = true;
    startAnimationLoop();
    
    SEATS.forEach(s => s.state = 'skeleton');
    els.btnReload.style.opacity = '0.5';
    
    try {
        const url = `${API_BASE_URL}/api/load_day?date=${els.dp.value}&force=${force}&t=${Date.now()}`;
        const res = await fetch(url);
        if (res.status === 503) { setTimeout(() => loadData(force), 2000); return; }
        const data = await res.json();
        
        if (Object.keys(data).length === 0) {
            SEATS.forEach(s => s.state = 'unknown');
            showToast("Fermé", true);
        } else {
            AVAILABILITY = data;
            showToast("À jour", false);
        }
    } catch (e) {
        SEATS.forEach(s => s.state = 'unknown');
        showToast("Erreur", true);
    }
    
    isFetchingData = false;
    els.btnReload.style.opacity = '1';
    updateMapState();
    requestRender();
}

function updateMapState() {
    if (Object.keys(AVAILABILITY).length === 0) return;
    const isSunday = new Date(els.dp.value).getDay() === 0;
    const s = Math.min(appState.startHour, appState.endHour);
    const e = Math.max(appState.startHour, appState.endHour);
    const reqSlots = [];
    
    if (s === e) reqSlots.push(formatTime(s, isSunday));
    else for (let h = s; h < e; h++) reqSlots.push(formatTime(h, isSunday));

    SEATS.forEach(seat => {
        const d = AVAILABILITY[seat.id];
        const gD = AVAILABILITY[seat.boxStartId];
        
        if (gD) { seat.hasPlug = !!gD.hasPlug; seat.hasLight = !!gD.hasLight; }
        if (d) {
            const isFree = reqSlots.length > 0 && reqSlots.every(r => d.slots.includes(r));
            seat.state = isFree ? 'free' : 'busy';
        } else {
            seat.state = 'unknown';
        }
    });
    updateActionBarUI();
}

let renderPending = false;
let animId = null;

function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function centerMap() {
    const viewW = els.viewport.clientWidth;
    mapState.scale = viewW / 1600;
    mapState.x = 0;
    mapState.y = Math.max(0, (els.viewport.clientHeight - (mapBaseHeight * mapState.scale)) / 2);
    clampMap();
}

function requestRender() {
    if (!renderPending && !isFetchingData) {
        renderPending = true;
        requestAnimationFrame(() => { renderPending = false; draw(); });
    }
}

function startAnimationLoop() {
    if (animId) return;
    const loop = () => {
        draw();
        if (isFetchingData) animId = requestAnimationFrame(loop);
        else animId = null;
    };
    animId = requestAnimationFrame(loop);
}

function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(mapState.scale * dpr, 0, 0, mapState.scale * dpr, mapState.x * dpr, mapState.y * dpr);

    if (mapImage.complete) {
        ctx.drawImage(mapImage, 0, 0, 1600, mapBaseHeight);
    }

    const now = Date.now();
    const drawnPlugs = new Set();
    const drawnLights = new Set();

    ctx.lineWidth = 3;
    SEATS.forEach(s => {
        if (s.hasPlug && !drawnPlugs.has(s.boxStartId)) {
            ctx.strokeStyle = C_PLUG;
            ctx.strokeRect(s.boxX - 3, s.boxY - 3, s.boxW + 6, s.boxH + 6);
            drawnPlugs.add(s.boxStartId);
        }
        if (s.hasLight && !drawnLights.has(s.boxStartId)) {
            ctx.fillStyle = C_LIGHT;
            ctx.shadowColor = C_LIGHT;
            ctx.shadowBlur = 20;
            ctx.fillRect(s.boxX, s.boxY, s.boxW, s.boxH);
            ctx.shadowBlur = 0; 
            drawnLights.add(s.boxStartId);
        }
    });

    ctx.lineWidth = 1;
    ctx.strokeStyle = C_BORDER;

    SEATS.forEach(s => {
        let scaleOffset = 0;
        let isSelected = appState.selectedSeatId === s.id;
        let isHovered = hoveredSeatId === s.id;

        if (isSelected || isHovered) {
            scaleOffset = -2;
            ctx.strokeStyle = C_SELECT;
            ctx.shadowColor = 'rgba(0,0,0,0.2)';
            ctx.shadowBlur = 6;
        } else {
            ctx.strokeStyle = C_BORDER;
            ctx.shadowBlur = 0;
        }

        if (s.state === 'skeleton') {
            ctx.fillStyle = C_UNKNOWN;
            ctx.beginPath();
            ctx.roundRect(s.x + scaleOffset, s.y + scaleOffset, s.w - (scaleOffset*2), s.h - (scaleOffset*2), 2);
            ctx.fill();

            const delayCalc = ((100 - (s.x/16)) + (100 - (s.y/(mapBaseHeight/100))));
            const phase = (now / 1500 * Math.PI * 2) - (delayCalc * 0.05);
            const alpha = (Math.sin(phase) + 1) / 2;
            ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.85})`;
        } else {
            if (s.state === 'busy') ctx.fillStyle = C_BUSY;
            else if (s.state === 'free') ctx.fillStyle = C_FREE;
            else ctx.fillStyle = C_UNKNOWN;
        }

        ctx.beginPath();
        ctx.roundRect(s.x + scaleOffset, s.y + scaleOffset, s.w - (scaleOffset*2), s.h - (scaleOffset*2), 2);
        ctx.fill();
        ctx.stroke();
    });
}

function getSeatAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const wX = (clientX - r.left - mapState.x) / mapState.scale;
    const wY = (clientY - r.top - mapState.y) / mapState.scale;

    for (let i = 0; i < SEATS.length; i++) {
        const s = SEATS[i];
        if (wX >= s.x && wX <= s.x + s.w && wY >= s.y && wY <= s.y + s.h) {
            return s;
        }
    }
    return null;
}

function setupPointerEvents() {
    const pointers = new Map();
    let startX = 0, startY = 0, sD = 0, sS = 1, sVX = 0, sVY = 0;
    let wasDragging = false;
    
    let pointerHistory = [];
    let inertiaAnimId = null;

    canvas.addEventListener('wheel', e => {
        e.preventDefault();
        cancelAnimationFrame(inertiaAnimId);
        mapState.x -= e.deltaX;
        mapState.y -= e.deltaY;
        clampMap();
        requestRender();
    }, { passive: false });

    canvas.addEventListener('pointerdown', e => {
        cancelAnimationFrame(inertiaAnimId);
        pointers.set(e.pointerId, e);
        canvas.setPointerCapture(e.pointerId);
        
        if (pointers.size === 1) { 
            startX = e.clientX; startY = e.clientY; 
            pointerHistory = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
        } else {
            pointerHistory = []; 
        }
        wasDragging = false;

        const pts = Array.from(pointers.values());
        if (pts.length === 1) {
            sVX = pts[0].clientX - mapState.x;
            sVY = pts[0].clientY - mapState.y;
        } else if (pts.length === 2) {
            sD = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
            sS = mapState.scale;
            sVX = ((pts[0].clientX + pts[1].clientX)/2) - mapState.x;
            sVY = ((pts[0].clientY + pts[1].clientY)/2) - mapState.y;
        }
    });

    canvas.addEventListener('pointermove', e => {
        if (pointers.size === 0 && e.pointerType === 'mouse') {
            const hovered = getSeatAt(e.clientX, e.clientY);
            const newId = hovered ? hovered.id : null;
            if (hoveredSeatId !== newId) {
                hoveredSeatId = newId;
                canvas.style.cursor = hovered ? 'pointer' : 'grab';
                if (hovered) {
                    tooltip.innerText = hovered.label;
                    tooltip.classList.add('visible');
                } else {
                    tooltip.classList.remove('visible');
                }
                requestRender();
            }
            if (hoveredSeatId) {
                tooltip.style.left = e.clientX + 'px';
                tooltip.style.top = (e.clientY - 15) + 'px';
            }
        }

        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, e);
        
        const pts = Array.from(pointers.values());
        if (pts.length === 2) {
            wasDragging = true;
            tooltip.classList.remove('visible');
            const cD = Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
            const rS = cD / sD;
            mapState.scale = Math.max(0.1, Math.min(sS * rS, 4));
            mapState.x = ((pts[0].clientX + pts[1].clientX)/2) - (sVX * rS);
            mapState.y = ((pts[0].clientY + pts[1].clientY)/2) - (sVY * rS);
            clampMap();
            requestRender();
        } else if (pts.length === 1) {
            const nowTime = performance.now();
            pointerHistory.push({ x: pts[0].clientX, y: pts[0].clientY, t: nowTime });
            pointerHistory = pointerHistory.filter(p => nowTime - p.t <= 100);

            const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
            if (dist > 5) wasDragging = true;
            
            if (wasDragging) {
                tooltip.classList.remove('visible');
                mapState.x = pts[0].clientX - sVX;
                mapState.y = pts[0].clientY - sVY;
                clampMap();
                requestRender();
            }
        }
    });

    const handleUp = e => {
        pointers.delete(e.pointerId);
        
        if (!wasDragging && (e.pointerType !== 'mouse' || pointers.size === 0)) {
            const clickedSeat = getSeatAt(e.clientX, e.clientY);
            if (clickedSeat) {
                appState.selectedSeatId = clickedSeat.id;
            } else {
                appState.selectedSeatId = null;
            }
            requestRender();
        }

        if (wasDragging && pointers.size === 0) {
            const nowTime = performance.now();
            pointerHistory = pointerHistory.filter(p => nowTime - p.t <= 100);
            
            let vX = 0, vY = 0;
            if (pointerHistory.length > 1) {
                const first = pointerHistory[0];
                const last = pointerHistory[pointerHistory.length - 1];
                const dt = last.t - first.t;
                
                if (dt > 0 && (nowTime - last.t) < 50) {
                    vX = ((last.x - first.x) / dt) * 16.6; 
                    vY = ((last.y - first.y) / dt) * 16.6;
                }
            }

            const friction = 0.95; 
            const applyInertia = () => {
                if (Math.abs(vX) > 0.1 || Math.abs(vY) > 0.1) {
                    mapState.x += vX;
                    mapState.y += vY;
                    
                    const viewW = els.viewport.clientWidth;
                    const viewH = els.viewport.clientHeight;
                    const cssMapW = 1600 * mapState.scale;
                    const cssMapH = mapBaseHeight * mapState.scale;
                    const minX = (viewW / 2) - cssMapW;
                    const maxX = viewW / 2;
                    const minY = (viewH / 2) - cssMapH;
                    const maxY = viewH / 2;

                    if (mapState.x <= minX || mapState.x >= maxX) vX = 0;
                    if (mapState.y <= minY || mapState.y >= maxY) vY = 0;

                    clampMap();
                    vX *= friction;
                    vY *= friction;
                    requestRender();
                    inertiaAnimId = requestAnimationFrame(applyInertia);
                }
            };
            inertiaAnimId = requestAnimationFrame(applyInertia);
        }

        if (pointers.size > 0) {
            const pts = Array.from(pointers.values());
            sVX = pts[0].clientX - mapState.x;
            sVY = pts[0].clientY - mapState.y;
        }
    };

    canvas.addEventListener('pointerup', handleUp);
    canvas.addEventListener('pointercancel', handleUp);
}

function formatTime(h, isSun) { return (h<10?'0'+h:h) + (isSun?':00':':30'); }
function showToast(msg, err) { els.toast.innerText = msg; els.toast.style.background = err ? '#ef4444' : '#22c55e'; els.toast.classList.add('visible'); setTimeout(() => els.toast.classList.remove('visible'), 4000); }
function openBooking(num) { const d = AVAILABILITY[num]; if(!d) return; window.open(`https://affluences.com/fr/sites/${SITE_SLUG}/reservation?type=${d.typeId||"245"}&date=${els.dp.value}&resource=${d.resourceId||num}`, '_blank'); }

function updateSliderUI() {
    const isSun = new Date(els.dp.value).getDay() === 0;
    const pS = ((appState.startHour - MIN_HOUR) / (MAX_HOUR - MIN_HOUR)) * 100;
    const pE = ((appState.endHour - MIN_HOUR) / (MAX_HOUR - MIN_HOUR)) * 100;
    els.thS.style.left = pS + '%'; els.thE.style.left = pE + '%';
    els.fill.style.left = Math.min(pS, pE) + '%'; els.fill.style.width = Math.abs(pE - pS) + '%';
    els.lblStart.innerText = formatTime(Math.min(appState.startHour, appState.endHour), isSun);
    els.lblEnd.innerText = formatTime(Math.max(appState.startHour, appState.endHour), isSun);
    updateMapState();
    requestRender();
}

function setupSlider() {
    let activeThumb = null;
    const getH = x => { const r = els.slider.getBoundingClientRect(); return Math.round(MIN_HOUR + Math.max(0, Math.min(1, (x - r.left)/r.width)) * (MAX_HOUR - MIN_HOUR)); };
    const move = e => { if(!activeThumb) return; const h = getH(e.clientX); if(activeThumb === 'S') appState.startHour = h; else appState.endHour = h; updateSliderUI(); };
    const up = e => { activeThumb = null; els.slider.releasePointerCapture(e.pointerId); els.slider.removeEventListener('pointermove', move); els.slider.removeEventListener('pointerup', up); els.slider.removeEventListener('pointercancel', up); };
    
    els.slider.addEventListener('pointerdown', e => {
        els.slider.setPointerCapture(e.pointerId);
        const h = getH(e.clientX);
        if (Math.abs(h - appState.startHour) < Math.abs(h - appState.endHour)) { activeThumb = 'S'; appState.startHour = h; }
        else { activeThumb = 'E'; appState.endHour = h; }
        updateSliderUI();
        els.slider.addEventListener('pointermove', move);
        els.slider.addEventListener('pointerup', up);
        els.slider.addEventListener('pointercancel', up);
    });
}

// Start
init();