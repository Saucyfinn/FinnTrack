///////////////////////////////////////////////////////////////
// FinnTrack Live Module
// Real-time boat tracking via WebSocket
///////////////////////////////////////////////////////////////

document.addEventListener("DOMContentLoaded", async () => {
    console.log("FinnTrack Live viewer loaded");

    // Initialize map
    FinnTrackMap.initMap("map");

    // State
    let reconnectTimer = null;
    let selectedBoat = null;

    // DOM elements
    const raceSelect = document.getElementById("raceSelect");
    const loadRaceBtn = document.getElementById("loadRaceBtn");
    const boatList = document.getElementById("boatList");
    const connectionStatus = document.getElementById("connectionStatus");

    // Toggle elements
    const toggleLabels = document.getElementById("toggleLabels");
    const toggleVectors = document.getElementById("toggleVectors");
    const toggleTrails = document.getElementById("toggleTrails");
    const toggleStart = document.getElementById("toggleStart");
    const toggleFinish = document.getElementById("toggleFinish");
    const toggleMarks = document.getElementById("toggleMarks");
    const togglePolygon = document.getElementById("togglePolygon");

    // Export buttons
    const exportGPX = document.getElementById("exportGPX");
    const exportKML = document.getElementById("exportKML");
    const exportJSON = document.getElementById("exportJSON");

    // Load race list
    async function populateRaceList() {
        const races = await FinnTrackAPI.loadRaceList();
        raceSelect.innerHTML = "";
        races.forEach(r => {
            const opt = document.createElement("option");
            opt.value = r.id;
            opt.textContent = r.label;
            raceSelect.appendChild(opt);
        });
        if (races.length > 0) {
            FinnTrackAPI.setRaceId(races[0].id);
        }
    }

    // Update connection status indicator
    function setConnectionStatus(status) {
        const dot = connectionStatus.querySelector(".status-dot");
        const text = connectionStatus.querySelector(".status-text");

        dot.className = "status-dot " + status;
        text.textContent = status === "connected" ? "Connected" :
                          status === "connecting" ? "Connecting..." : "Disconnected";
    }

    // Render boat list in sidebar
    function renderBoatList(boats) {
        boatList.innerHTML = "";
        boats.sort().forEach(boatId => {
            const li = document.createElement("li");
            const color = FinnTrackMap.getBoatColor(boatId);
            li.innerHTML = `<span style="color:${color}">●</span> ${boatId}`;
            li.onclick = () => {
                selectedBoat = boatId;
                FinnTrackMap.focusBoat(boatId);
                FinnTrackMap.highlightBoat(boatId);
            };
            boatList.appendChild(li);
        });
    }

    // Handle incoming WebSocket messages
    function handleMessage(msg) {
        setConnectionStatus("connected");

        if (msg.type === "full") {
            // Full boat snapshot
            FinnTrackMap.clearBoatLayers();
            const boats = msg.boats || {};
            for (const boatId in boats) {
                FinnTrackMap.updateBoat(boatId, boats[boatId], {
                    appendTrail: false,
                    onClick: (id) => {
                        selectedBoat = id;
                        FinnTrackMap.focusBoat(id);
                        FinnTrackMap.highlightBoat(id);
                        FinnTrackMap.showBoatPopup(id, boats[id]);
                    }
                });
            }
            renderBoatList(Object.keys(boats));
        }

        if (msg.type === "update") {
            // Single boat update
            FinnTrackMap.updateBoat(msg.boat, msg.data, {
                appendTrail: true,
                onClick: (id) => {
                    selectedBoat = id;
                    FinnTrackMap.focusBoat(id);
                    FinnTrackMap.highlightBoat(id);
                    FinnTrackMap.showBoatPopup(id, msg.data);
                }
            });

            // Add to boat list if new
            if (!boatList.querySelector(`[data-boat="${msg.boat}"]`)) {
                const li = document.createElement("li");
                li.dataset.boat = msg.boat;
                const color = FinnTrackMap.getBoatColor(msg.boat);
                li.innerHTML = `<span style="color:${color}">●</span> ${msg.boat}`;
                li.onclick = () => {
                    selectedBoat = msg.boat;
                    FinnTrackMap.focusBoat(msg.boat);
                    FinnTrackMap.highlightBoat(msg.boat);
                };
                boatList.appendChild(li);
            }
        }
    }

    // Handle WebSocket disconnect
    function handleDisconnect() {
        setConnectionStatus("disconnected");

        // Auto-reconnect after 3 seconds
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
            setConnectionStatus("connecting");
            FinnTrackAPI.connectLive(handleMessage, handleDisconnect);
        }, 3000);
    }

    // Connect to live stream
    function connect() {
        setConnectionStatus("connecting");
        FinnTrackAPI.connectLive(handleMessage, handleDisconnect);
    }

    // Load course and connect
    async function loadRace() {
        const raceId = raceSelect.value;
        if (!raceId) return;

        FinnTrackAPI.setRaceId(raceId);
        FinnTrackAPI.disconnectLive();
        FinnTrackMap.clearBoatLayers();
        boatList.innerHTML = "";

        // Load course layers
        const courseData = await FinnTrackAPI.loadCourseData();
        FinnTrackMap.renderCourseLayers(courseData);

        // Connect to live feed
        connect();
    }

    // Event listeners
    loadRaceBtn.addEventListener("click", loadRace);

    // Layer toggles
    if (toggleLabels) toggleLabels.addEventListener("change", e => FinnTrackMap.setLabelsVisible(e.target.checked));
    if (toggleVectors) toggleVectors.addEventListener("change", e => FinnTrackMap.setVectorsVisible(e.target.checked));
    if (toggleTrails) toggleTrails.addEventListener("change", e => FinnTrackMap.setTrailsVisible(e.target.checked));
    if (toggleStart) toggleStart.addEventListener("change", e => FinnTrackMap.setStartLineVisible(e.target.checked));
    if (toggleFinish) toggleFinish.addEventListener("change", e => FinnTrackMap.setFinishLineVisible(e.target.checked));
    if (toggleMarks) toggleMarks.addEventListener("change", e => FinnTrackMap.setMarksVisible(e.target.checked));
    if (togglePolygon) togglePolygon.addEventListener("change", e => FinnTrackMap.setPolygonVisible(e.target.checked));

    // Export buttons
    if (exportGPX) exportGPX.addEventListener("click", () => FinnTrackAPI.exportGPX());
    if (exportKML) exportKML.addEventListener("click", () => FinnTrackAPI.exportKML());
    if (exportJSON) exportJSON.addEventListener("click", async () => {
        const data = await FinnTrackAPI.loadReplayData();
        if (data && data.boats) {
            FinnTrackAPI.exportJSON(data.boats);
        }
    });

    // Handle window resize
    window.addEventListener("resize", () => {
        const map = FinnTrackMap.getMap();
        if (map) map.invalidateSize();
    });

    // Initial load
    await populateRaceList();
    await loadRace();
});
