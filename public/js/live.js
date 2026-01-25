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
    let followingBoat = null;
    let fleetData = null;

    // DOM elements
    const raceSelect = document.getElementById("raceSelect");
    const loadRaceBtn = document.getElementById("loadRaceBtn");
    const boatList = document.getElementById("boatList");
    const connectionStatus = document.getElementById("connectionStatus");
    const boatSelect = document.getElementById("boatSelect");
    const followBoatBtn = document.getElementById("followBoatBtn");
    const resetViewBtn = document.getElementById("resetViewBtn");

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

    // Load fleet data for boat dropdown
    async function loadFleetData() {
        try {
            const res = await fetch("/data/fleet.json");
            if (!res.ok) return;
            fleetData = await res.json();
            populateBoatSelect();
        } catch (err) {
            console.log("Fleet data not available");
        }
    }

    // Populate boat dropdown from fleet data
    function populateBoatSelect() {
        if (!fleetData || !boatSelect) return;

        boatSelect.innerHTML = '<option value="">-- All boats --</option>';

        const entries = fleetData.entries || [];
        entries.forEach(entry => {
            const opt = document.createElement("option");
            opt.value = entry.sailNumber;
            opt.textContent = `${entry.sailNumber} - ${entry.skipper}`;
            boatSelect.appendChild(opt);
        });
    }

    // Update boat dropdown when boats appear on map
    function updateBoatSelectFromLive(boatIds) {
        if (!boatSelect) return;

        // Add any boats that aren't in fleet data
        const existingOptions = new Set(Array.from(boatSelect.options).map(o => o.value));

        boatIds.forEach(boatId => {
            if (!existingOptions.has(boatId)) {
                const opt = document.createElement("option");
                opt.value = boatId;
                opt.textContent = boatId;
                boatSelect.appendChild(opt);
            }
        });
    }

    // Follow selected boat (auto-center on updates)
    function startFollowing(boatId) {
        followingBoat = boatId;
        if (boatId) {
            FinnTrackMap.focusBoat(boatId, 16);
            FinnTrackMap.highlightBoat(boatId);
            if (followBoatBtn) followBoatBtn.textContent = "Following...";
        }
    }

    // Stop following
    function stopFollowing() {
        followingBoat = null;
        FinnTrackMap.resetHighlight();
        if (followBoatBtn) followBoatBtn.textContent = "Follow";
    }

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
            updateBoatSelectFromLive(Object.keys(boats));

            // Re-focus on followed boat if set
            if (followingBoat && boats[followingBoat]) {
                FinnTrackMap.focusBoat(followingBoat, 16);
                FinnTrackMap.highlightBoat(followingBoat);
            }
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

            // Auto-center on followed boat
            if (followingBoat === msg.boat) {
                FinnTrackMap.focusBoat(msg.boat, 16);
            }

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
                updateBoatSelectFromLive([msg.boat]);
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

    // Follow boat controls
    if (followBoatBtn) {
        followBoatBtn.addEventListener("click", () => {
            const boatId = boatSelect ? boatSelect.value : null;
            if (boatId) {
                startFollowing(boatId);
            }
        });
    }

    if (resetViewBtn) {
        resetViewBtn.addEventListener("click", () => {
            stopFollowing();
            if (boatSelect) boatSelect.value = "";
            FinnTrackMap.fitToBounds();
        });
    }

    if (boatSelect) {
        boatSelect.addEventListener("change", () => {
            const boatId = boatSelect.value;
            if (boatId) {
                selectedBoat = boatId;
                FinnTrackMap.focusBoat(boatId, 15);
                FinnTrackMap.highlightBoat(boatId);
            } else {
                stopFollowing();
            }
        });
    }

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
    await loadFleetData();
    await populateRaceList();
    await loadRace();
});
