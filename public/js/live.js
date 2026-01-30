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
    let currentBoats = {}; // Track current boats for reference

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
            console.log("Fleet data not available:", err);
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
        console.log("Loading race list...");
        const races = await FinnTrackAPI.loadRaceList();
        console.log("Loaded races:", races.length);

        if (!raceSelect) return;

        raceSelect.innerHTML = "";

        if (races.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "-- No races available --";
            raceSelect.appendChild(opt);
            return;
        }

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
        if (!connectionStatus) return;

        const dot = connectionStatus.querySelector(".status-dot");
        const text = connectionStatus.querySelector(".status-text");

        if (dot) {
            dot.className = "status-dot " + status;
        }
        if (text) {
            text.textContent = status === "connected" ? "Connected" :
                              status === "connecting" ? "Connecting..." : "Disconnected";
        }
    }

    // Render boat list in sidebar
    function renderBoatList(boatIds) {
        if (!boatList) return;

        boatList.innerHTML = "";
        const sortedIds = [...boatIds].sort();

        sortedIds.forEach(boatId => {
            const li = document.createElement("li");
            li.dataset.boat = boatId;
            const color = FinnTrackMap.getBoatColor(boatId);
            li.innerHTML = `<span style="color:${color}">●</span> ${boatId}`;
            li.style.cursor = "pointer";
            li.style.padding = "5px";
            li.onclick = () => {
                selectedBoat = boatId;
                FinnTrackMap.focusBoat(boatId);
                FinnTrackMap.highlightBoat(boatId);
                if (currentBoats[boatId]) {
                    FinnTrackMap.showBoatPopup(boatId, currentBoats[boatId]);
                }
            };
            boatList.appendChild(li);
        });
    }

    // Handle incoming WebSocket messages
    function handleMessage(msg) {
        setConnectionStatus("connected");
        console.log("Handling message type:", msg.type);

        // Handle "full" message (initial snapshot or full refresh)
        if (msg.type === "full" || msg.type === "snapshot" || msg.type === "roster") {
            const boats = msg.boats || {};

            // Handle both object and array formats
            let boatsObj = boats;
            if (Array.isArray(boats)) {
                boatsObj = {};
                boats.forEach(b => {
                    if (b.boatId) boatsObj[b.boatId] = b;
                });
            }

            FinnTrackMap.clearBoatLayers();
            currentBoats = boatsObj;

            for (const boatId in boatsObj) {
                const boat = boatsObj[boatId];
                if (!boat) continue;

                // Normalize boat data for map
                const frame = {
                    lat: boat.lat ?? boat.latitude,
                    lng: boat.lng ?? boat.lon ?? boat.longitude,
                    speed: boat.speed ?? boat.sog ?? 0,
                    heading: boat.heading ?? boat.cog ?? 0,
                    timestamp: boat.timestamp ?? boat.t ?? boat.lastSeen
                };

                // Skip boats without valid coordinates
                if (!Number.isFinite(frame.lat) || !Number.isFinite(frame.lng)) {
                    console.log(`Skipping boat ${boatId} - no valid coordinates`);
                    continue;
                }

                FinnTrackMap.updateBoat(boatId, frame, {
                    appendTrail: false,
                    onClick: (id) => {
                        selectedBoat = id;
                        FinnTrackMap.focusBoat(id);
                        FinnTrackMap.highlightBoat(id);
                        FinnTrackMap.showBoatPopup(id, frame);
                    }
                });
            }

            const boatIds = Object.keys(boatsObj).filter(id => {
                const b = boatsObj[id];
                return b && Number.isFinite(b.lat ?? b.latitude) && Number.isFinite(b.lng ?? b.lon ?? b.longitude);
            });

            renderBoatList(boatIds);
            updateBoatSelectFromLive(boatIds);

            // Re-focus on followed boat if set
            if (followingBoat && boatsObj[followingBoat]) {
                const boat = boatsObj[followingBoat];
                if (Number.isFinite(boat.lat) && Number.isFinite(boat.lng ?? boat.lon)) {
                    FinnTrackMap.focusBoat(followingBoat, 16);
                    FinnTrackMap.highlightBoat(followingBoat);
                }
            }
        }

        // Handle "update" message (single boat telemetry)
        if (msg.type === "update" || msg.type === "telemetry") {
            const boatId = msg.boat || msg.boatId;
            const data = msg.data || msg.telemetry || msg;

            if (!boatId || !data) return;

            // Normalize boat data
            const frame = {
                lat: data.lat ?? data.latitude,
                lng: data.lng ?? data.lon ?? data.longitude,
                speed: data.speed ?? data.sog ?? 0,
                heading: data.heading ?? data.cog ?? 0,
                timestamp: data.timestamp ?? data.t ?? data.lastSeen
            };

            // Skip if no valid coordinates
            if (!Number.isFinite(frame.lat) || !Number.isFinite(frame.lng)) {
                console.log(`Skipping update for ${boatId} - no valid coordinates`);
                return;
            }

            currentBoats[boatId] = data;

            FinnTrackMap.updateBoat(boatId, frame, {
                appendTrail: true,
                onClick: (id) => {
                    selectedBoat = id;
                    FinnTrackMap.focusBoat(id);
                    FinnTrackMap.highlightBoat(id);
                    FinnTrackMap.showBoatPopup(id, frame);
                }
            });

            // Auto-center on followed boat
            if (followingBoat === boatId) {
                FinnTrackMap.focusBoat(boatId, 16);
            }

            // Add to boat list if new
            if (boatList && !boatList.querySelector(`[data-boat="${boatId}"]`)) {
                const li = document.createElement("li");
                li.dataset.boat = boatId;
                const color = FinnTrackMap.getBoatColor(boatId);
                li.innerHTML = `<span style="color:${color}">●</span> ${boatId}`;
                li.style.cursor = "pointer";
                li.style.padding = "5px";
                li.onclick = () => {
                    selectedBoat = boatId;
                    FinnTrackMap.focusBoat(boatId);
                    FinnTrackMap.highlightBoat(boatId);
                };
                boatList.appendChild(li);
                updateBoatSelectFromLive([boatId]);
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
        if (!raceSelect) return;

        const selectedRaceId = raceSelect.value;
        if (!selectedRaceId) {
            console.log("No race selected");
            return;
        }

        console.log("Loading race:", selectedRaceId);
        FinnTrackAPI.setRaceId(selectedRaceId);
        FinnTrackAPI.disconnectLive();
        FinnTrackMap.clearBoatLayers();
        currentBoats = {};

        if (boatList) boatList.innerHTML = "";

        // Load course layers
        const courseData = await FinnTrackAPI.loadCourseData();
        if (courseData) {
            FinnTrackMap.renderCourseLayers(courseData);
        }

        // Connect to live feed
        connect();
    }

    // Event listeners
    if (loadRaceBtn) {
        loadRaceBtn.addEventListener("click", loadRace);
    }

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
        const data = await FinnTrackAPI.loadBoatsSnapshot();
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
    console.log("Starting initial load...");
    await loadFleetData();
    await populateRaceList();

    // Auto-load first race if available
    if (raceSelect && raceSelect.value) {
        await loadRace();
    }
});
