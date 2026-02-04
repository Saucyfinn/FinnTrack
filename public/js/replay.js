///////////////////////////////////////////////////////////////
// FinnTrack Replay Module
// Race replay with timeline, events, and playback controls
///////////////////////////////////////////////////////////////

document.addEventListener("DOMContentLoaded", async () => {
    console.log("FinnTrack Replay viewer loaded");

    // Initialize map
    FinnTrackMap.initMap("map");

    // Replay state
    let replayFrames = {};
    let frameIndex = 0;
    let maxFrames = 0;
    let playing = false;
    let replaySpeed = 1;
    let events = [];
    let lastTriggeredEventIndex = -1;
    let courseCache = { startTime: null, marks: [], finishLine: null };
    let selectedBoat = null;

    // DOM elements
    const raceSelect = document.getElementById("raceSelect");
    const loadRaceBtn = document.getElementById("loadRaceBtn");
    const boatList = document.getElementById("boatList");

    // Playback controls
    const timeline = document.getElementById("timeline");
    const playBtn = document.getElementById("playBtn");
    const pauseBtn = document.getElementById("pauseBtn");
    const stepBtn = document.getElementById("stepBtn");
    const frameInfo = document.getElementById("frameInfo");
    const speedSelect = document.getElementById("speedSelect");

    // Event elements
    const eventTrack = document.getElementById("eventTrack");
    const eventButtons = document.getElementById("eventButtons");

    // Toggles
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

                const frames = replayFrames[boatId];
                if (frames && frames[frameIndex]) {
                    FinnTrackMap.showBoatPopup(boatId, frames[frameIndex]);
                }
            };
            boatList.appendChild(li);
        });
    }

    // Load replay data
    async function loadReplayData() {
        const data = await FinnTrackAPI.loadReplayData();
        if (!data) {
            alert("Failed to load replay data");
            return;
        }

        replayFrames = data.boats || {};
        frameIndex = 0;

        // Calculate max frames
        const counts = Object.values(replayFrames).map(frames => Array.isArray(frames) ? frames.length : 0);
        maxFrames = counts.length ? Math.max(...counts) : 0;

        // Setup timeline
        timeline.min = 0;
        timeline.max = Math.max(0, maxFrames - 1);
        timeline.value = 0;
        updateFrameInfo();

        // Clear and setup boats
        FinnTrackMap.clearBoatLayers();

        for (const boatId in replayFrames) {
            const frames = replayFrames[boatId];
            if (!frames || frames.length === 0) continue;

            const f0 = frames[0];

            // Create boat marker
            FinnTrackMap.updateBoat(boatId, f0, {
                onClick: (id) => {
                    selectedBoat = id;
                    FinnTrackMap.focusBoat(id);
                    FinnTrackMap.highlightBoat(id);
                    const currentFrames = replayFrames[id];
                    if (currentFrames && currentFrames[frameIndex]) {
                        FinnTrackMap.showBoatPopup(id, currentFrames[frameIndex]);
                    }
                }
            });

            // Set full trail
            FinnTrackMap.setBoatTrail(boatId, frames);
        }

        // Fit map to bounds
        FinnTrackMap.fitToBounds();

        // Render boat list
        renderBoatList(Object.keys(replayFrames));

        // Update frame display
        updateReplayFrame(0);

        // Detect events
        await detectEvents();
    }

    // Update frame info display
    function updateFrameInfo() {
        if (frameInfo) {
            frameInfo.textContent = `${frameIndex} / ${Math.max(0, maxFrames - 1)}`;
        }
    }

    // Update replay to specific frame
    function updateReplayFrame(i) {
        if (!maxFrames) return;
        frameIndex = Math.max(0, Math.min(i, maxFrames - 1));

        for (const boatId in replayFrames) {
            const frames = replayFrames[boatId];
            if (!frames || frameIndex >= frames.length) continue;

            const f = frames[frameIndex];
            FinnTrackMap.updateBoat(boatId, f, { appendTrail: false });
        }

        timeline.value = frameIndex;
        updateFrameInfo();

        // Trigger events
        maybeTriggerEvents(frameIndex);
    }

    // Replay animation loop
    function replayLoop() {
        if (!playing) return;

        frameIndex += replaySpeed;
        if (frameIndex >= maxFrames) {
            playing = false;
            frameIndex = maxFrames - 1;
            return;
        }

        updateReplayFrame(Math.floor(frameIndex));
        requestAnimationFrame(replayLoop);
    }

    // Haversine distance in meters
    function distanceMeters(lat1, lon1, lat2, lon2) {
        const R = 6371000;
        const toRad = (x) => (x * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    // Find frame index for timestamp
    function timestampToFrameIndex(ts) {
        let refFrames = null;
        for (const b in replayFrames) {
            if (!refFrames || replayFrames[b].length > refFrames.length) {
                refFrames = replayFrames[b];
            }
        }
        if (!refFrames || !refFrames.length) return 0;

        for (let i = 0; i < refFrames.length; i++) {
            if (refFrames[i].timestamp >= ts) return i;
        }
        return refFrames.length - 1;
    }

    // Get timestamp at frame
    function guessTimestampAtFrame(frame) {
        let refFrames = null;
        for (const b in replayFrames) {
            if (!refFrames || replayFrames[b].length > refFrames.length) {
                refFrames = replayFrames[b];
            }
        }
        if (!refFrames || !refFrames.length) return null;
        const idx = Math.min(frame, refFrames.length - 1);
        return refFrames[idx].timestamp;
    }

    // Detect race events
    async function detectEvents() {
        events = [];
        lastTriggeredEventIndex = -1;

        if (!replayFrames || Object.keys(replayFrames).length === 0 || maxFrames < 2) {
            renderEventMarkers();
            renderEventButtons();
            return;
        }

        // Start event
        if (courseCache.startTime) {
            events.push({
                type: "start",
                label: "Start",
                frame: timestampToFrameIndex(courseCache.startTime),
                timestamp: courseCache.startTime
            });
        }

        const boatIds = Object.keys(replayFrames);
        const threshold = Math.max(8, Math.floor(boatIds.length * 0.08));
        const step = Math.max(1, Math.floor(maxFrames / 800));
        const radiusM = 40;

        // Mark events
        for (let m = 0; m < (courseCache.marks || []).length; m++) {
            const [mlat, mlng] = courseCache.marks[m];
            let foundFrame = null;

            for (let fi = 0; fi < maxFrames; fi += step) {
                let count = 0;
                for (const b of boatIds) {
                    const arr = replayFrames[b];
                    if (!arr || fi >= arr.length) continue;
                    const f = arr[fi];
                    if (distanceMeters(f.lat, f.lng, mlat, mlng) <= radiusM) {
                        count++;
                        if (count >= threshold) {
                            foundFrame = fi;
                            break;
                        }
                    }
                }
                if (foundFrame !== null) break;
            }

            if (foundFrame !== null) {
                events.push({
                    type: "mark",
                    label: `Mark ${m + 1}`,
                    frame: foundFrame,
                    timestamp: guessTimestampAtFrame(foundFrame)
                });
            }
        }

        // Finish event
        if (courseCache.finishLine?.A && courseCache.finishLine?.B) {
            const A = courseCache.finishLine.A, B = courseCache.finishLine.B;
            const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];

            let finishFrame = null;
            for (let fi = 0; fi < maxFrames; fi += step) {
                let count = 0;
                for (const b of boatIds) {
                    const arr = replayFrames[b];
                    if (!arr || fi >= arr.length) continue;
                    const f = arr[fi];
                    if (distanceMeters(f.lat, f.lng, mid[0], mid[1]) <= 60) {
                        count++;
                        if (count >= threshold) {
                            finishFrame = fi;
                            break;
                        }
                    }
                }
                if (finishFrame !== null) break;
            }

            if (finishFrame !== null) {
                events.push({
                    type: "finish",
                    label: "Finish",
                    frame: finishFrame,
                    timestamp: guessTimestampAtFrame(finishFrame)
                });
            }
        }

        events.sort((a, b) => a.frame - b.frame);
        renderEventMarkers();
        renderEventButtons();
    }

    // Render event markers on timeline
    function renderEventMarkers() {
        if (!eventTrack) return;
        eventTrack.innerHTML = "";
        if (!events.length || maxFrames <= 1) return;

        for (const ev of events) {
            const dot = document.createElement("div");
            dot.title = ev.label;
            dot.className = "event-dot";
            dot.style.position = "absolute";
            dot.style.top = "2px";
            dot.style.width = "10px";
            dot.style.height = "10px";
            dot.style.borderRadius = "50%";
            dot.style.cursor = "pointer";

            if (ev.type === "start") dot.style.background = "#0077cc";
            else if (ev.type === "finish") dot.style.background = "#00a86b";
            else dot.style.background = "#ff6b35";

            const pct = ev.frame / (maxFrames - 1);
            dot.style.left = `calc(${(pct * 100).toFixed(2)}% - 5px)`;

            dot.onclick = () => {
                playing = false;
                updateReplayFrame(ev.frame);
            };

            eventTrack.appendChild(dot);
        }
    }

    // Render event buttons
    function renderEventButtons() {
        if (!eventButtons) return;
        eventButtons.innerHTML = "";

        for (const ev of events) {
            const btn = document.createElement("button");
            btn.textContent = ev.label;
            btn.onclick = () => {
                playing = false;
                updateReplayFrame(ev.frame);
            };
            eventButtons.appendChild(btn);
        }
    }

    // Audio beep for events
    function beep(freq = 880, ms = 120) {
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            const ctx = new AudioCtx();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            osc.type = "sine";
            gain.gain.value = 0.08;
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            setTimeout(() => { osc.stop(); ctx.close(); }, ms);
        } catch (_) {}
    }

    // Trigger events during playback
    function maybeTriggerEvents(currentFrame) {
        if (!events.length) return;
        const nextIdx = lastTriggeredEventIndex + 1;
        if (nextIdx >= events.length) return;

        const ev = events[nextIdx];
        if (currentFrame >= ev.frame) {
            lastTriggeredEventIndex = nextIdx;
            if (ev.type === "start") beep(880, 140);
            if (ev.type === "finish") beep(440, 220);
        }
    }

    // Load race
    async function loadRace() {
        const raceId = raceSelect.value;
        if (!raceId) return;

        FinnTrackAPI.setRaceId(raceId);

        // Reset state
        playing = false;
        frameIndex = 0;
        events = [];
        lastTriggeredEventIndex = -1;

        // Load course layers
        const courseData = await FinnTrackAPI.loadCourseData();
        FinnTrackMap.renderCourseLayers(courseData);

        // Cache course info for event detection
        if (courseData) {
            courseCache.startTime = courseData.startTime ?? null;
            courseCache.marks = courseData.marks ?? [];
            courseCache.finishLine = courseData.finishLine ?? null;
        }

        // Load replay data
        await loadReplayData();
    }

    // Event listeners - Playback controls
    playBtn.addEventListener("click", () => {
        playing = true;
        replayLoop();
    });

    pauseBtn.addEventListener("click", () => {
        playing = false;
    });

    stepBtn.addEventListener("click", () => {
        playing = false;
        updateReplayFrame(frameIndex + 1);
    });

    timeline.addEventListener("input", (e) => {
        playing = false;
        updateReplayFrame(Number(e.target.value));
    });

    speedSelect.addEventListener("change", (e) => {
        replaySpeed = Number(e.target.value);
    });

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
    if (exportJSON) exportJSON.addEventListener("click", () => FinnTrackAPI.exportJSON(replayFrames));

    // Handle window resize
    window.addEventListener("resize", () => {
        const map = FinnTrackMap.getMap();
        if (map) map.invalidateSize();
    });

    // Initial load
    await populateRaceList();
    await loadRace();
});
