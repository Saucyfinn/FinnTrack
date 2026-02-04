// FinnTrack Analytics

let raceId = null;
let windDeg = null;
let boats = [];
let pointsByBoat = {};

let speedChart = null;
let vmgChart = null;

document.getElementById("loadBtn").onclick = loadRace;
document.getElementById("exportCsvBtn").onclick = exportCSV;

async function loadRace() {
    raceId = document.getElementById("raceInput").value.trim();
    windDeg = Number(document.getElementById("windInput").value);
    if (!raceId) return alert("Enter raceId");

    // Request last 4 hours of data
    const now = Date.now();
    const from = now - 4 * 60 * 60 * 1000;

    const url = `/replay?raceId=${raceId}&from=${from}&to=${now}&hz=4`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!data.ok) return alert("Replay error: " + data.error);
    boats = data.boatIds;
    pointsByBoat = rebuildPoints(data.frames);

    buildBoatList();
}

function rebuildPoints(frames) {
    const container = {};

    frames.forEach(frame => {
        const t = frame.t;
        for (const boatId of Object.keys(frame.boats)) {
            if (!container[boatId]) container[boatId] = [];
            const p = frame.boats[boatId];
            container[boatId].push({
                t,
                lat: p.lat,
                lon: p.lon,
                sog: p.sog,
                cog: p.cog
            });
        }
    });

    return container;
}

function buildBoatList() {
    const ul = document.getElementById("boatList");
    ul.innerHTML = "";

    boats.forEach(boatId => {
        const li = document.createElement("li");
        li.textContent = boatId;
        li.onclick = () => loadBoat(boatId);
        ul.appendChild(li);
    });
}

function loadBoat(boatId) {
    const pts = pointsByBoat[boatId];
    if (!pts || pts.length < 2) return;

    document.getElementById("boatTitle").innerText = boatId;

    const speed = pts.map(p => (p.sog || 0));
    const timeLabels = pts.map(p => new Date(p.t).toLocaleTimeString());

    const vmg = computeVMG(pts);
    const { tacks, gybes } = detectManeuvers(pts);
    const dist = computeDistance(pts);
    const maxSpeed = Math.max(...speed).toFixed(2);
    const avgVMG = vmg.length ? (vmg.reduce((a,b)=>a+b, 0) / vmg.length).toFixed(2) : "-";

    document.getElementById("statDistance").innerText = dist.toFixed(2) + " km";
    document.getElementById("statMaxSpeed").innerText = maxSpeed + " kn";
    document.getElementById("statTacks").innerText = tacks;
    document.getElementById("statGybes").innerText = gybes;
    document.getElementById("statAvgVMG").innerText = avgVMG + " kn";

    drawSpeedChart(timeLabels, speed);
    drawVMGChart(timeLabels, vmg);
}

/* ---------- Calculations ---------- */

function computeDistance(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        total += haversine(pts[i-1], pts[i]);
    }
    return total;
}

function haversine(a, b) {
    const R = 6371; // km
    const dLat = (b.lat - a.lat) * Math.PI/180;
    const dLon = (b.lon - a.lon) * Math.PI/180;
    const lat1 = a.lat * Math.PI/180;
    const lat2 = b.lat * Math.PI/180;

    const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function computeVMG(pts) {
    if (!windDeg) return pts.map(_ => 0);

    return pts.map(p => {
        if (!p.sog || p.cog == null) return 0;
        const angleDiff = Math.abs((p.cog - windDeg + 360) % 360);
        return p.sog * Math.cos(angleDiff * Math.PI/180);
    });
}

function detectManeuvers(pts) {
    let tacks = 0, gybes = 0;

    for (let i = 2; i < pts.length; i++) {
        const prev = pts[i-1].cog;
        const curr = pts[i].cog;

        if (prev == null || curr == null) continue;

        const diff = ((curr - prev + 540) % 360) - 180;

        if (Math.abs(diff) > 60) {
            if (diff > 0) gybes++;
            else tacks++;
        }
    }
    return { tacks, gybes };
}

/* ---------- Charts ---------- */

function drawSpeedChart(labels, data) {
    const ctx = document.getElementById("speedChart");

    if (speedChart) speedChart.destroy();

    speedChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Speed (kn)',
                data,
                borderColor: '#0099ff',
                backgroundColor: 'rgba(0,153,255,0.15)',
                borderWidth: 2,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            scales: { x: { display: false } }
        }
    });
}

function drawVMGChart(labels, data) {
    const ctx = document.getElementById("vmgChart");

    if (vmgChart) vmgChart.destroy();

    vmgChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'VMG (kn)',
                data,
                borderColor: '#ff6600',
                backgroundColor: 'rgba(255,102,0,0.15)',
                borderWidth: 2,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            scales: { x: { display: false } }
        }
    });
}

/* ---------- CSV Export ---------- */

function exportCSV() {
    if (!boats.length) return alert("Load a race first.");

    let rows = ["boatId,t,lat,lon,sog,cog"];

    boats.forEach(boatId => {
        (pointsByBoat[boatId] || []).forEach(p => {
            rows.push(`${boatId},${p.t},${p.lat},${p.lon},${p.sog || ""},${p.cog || ""}`);
        });
    });

    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `${raceId}-analytics.csv`;
    a.click();
}
