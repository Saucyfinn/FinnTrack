///////////////////////////////////////////////////////////////
// FinnTrack API Module
// WebSocket connections, fetch calls, exports
///////////////////////////////////////////////////////////////

const FinnTrackAPI = (function() {
    let ws = null;
    let raceId = "AUSNATS-2026-R01";
    let onMessageCallback = null;
    let onCloseCallback = null;

    // Get/Set race ID
    function getRaceId() { return raceId; }
    function setRaceId(id) { raceId = id; }

    // Determine API base URL (supports both api subdomain and same origin)
    function getApiBase() {
        // If we're on finntracker.org, use api.finntracker.org
        if (location.hostname === 'finntracker.org' || location.hostname === 'www.finntracker.org') {
            return 'https://api.finntracker.org';
        }
        // Otherwise use same origin (for local dev)
        return '';
    }

    // Load race list from server
    async function loadRaceList() {
        try {
            // Try /race/list first (new endpoint), fall back to /races
            let res = await fetch(`${getApiBase()}/race/list`);
            if (!res.ok) {
                res = await fetch(`${getApiBase()}/races`);
            }
            if (!res.ok) return [];
            const json = await res.json();
            return json.races || [];
        } catch (err) {
            console.error("Failed to load race list:", err);
            return [];
        }
    }

    // Load course data (start line, finish line, marks, polygon, wind)
    async function loadCourseData() {
        try {
            const res = await fetch(`${getApiBase()}/autocourse?raceId=${encodeURIComponent(raceId)}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.error("Failed to load course data:", err);
            return null;
        }
    }

    // Load replay data
    async function loadReplayData() {
        try {
            const res = await fetch(`${getApiBase()}/replay-multi?raceId=${encodeURIComponent(raceId)}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.error("Failed to load replay data:", err);
            return null;
        }
    }

    // Load current boats snapshot
    async function loadBoatsSnapshot() {
        try {
            const res = await fetch(`${getApiBase()}/boats?raceId=${encodeURIComponent(raceId)}`);
            if (!res.ok) return null;
            return await res.json();
        } catch (err) {
            console.error("Failed to load boats snapshot:", err);
            return null;
        }
    }

    // WebSocket connection for live updates
    // Supports both /live and /ws/live endpoints
    function connectLive(onMessage, onClose) {
        onMessageCallback = onMessage;
        onCloseCallback = onClose;

        if (ws) {
            ws.close();
            ws = null;
        }

        // Determine WebSocket URL
        let wsHost = location.host;
        if (location.hostname === 'finntracker.org' || location.hostname === 'www.finntracker.org') {
            wsHost = 'api.finntracker.org';
        }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

        // Try /live first (simpler), will also work with /ws/live on server side
        const wsUrl = `${protocol}//${wsHost}/live?raceId=${encodeURIComponent(raceId)}`;

        console.log("Connecting to WebSocket:", wsUrl);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("WebSocket connected");
        };

        ws.onmessage = (evt) => {
            try {
                const msg = JSON.parse(evt.data);
                console.log("WebSocket message:", msg.type);
                if (onMessageCallback) onMessageCallback(msg);
            } catch (err) {
                console.error("Failed to parse WebSocket message:", err);
            }
        };

        ws.onclose = (evt) => {
            console.log("WebSocket closed:", evt.code, evt.reason);
            if (onCloseCallback) onCloseCallback();
        };

        ws.onerror = (err) => {
            console.error("WebSocket error:", err);
        };
    }

    function disconnectLive() {
        if (ws) {
            ws.close();
            ws = null;
        }
    }

    function isConnected() {
        return ws && ws.readyState === WebSocket.OPEN;
    }

    // Export functions
    async function downloadFromEndpoint(url, filename) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                alert(`Export failed: ${res.status}`);
                return;
            }
            const blob = await res.blob();
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = filename;
            link.click();
            URL.revokeObjectURL(link.href);
        } catch (err) {
            console.error("Export failed:", err);
            alert("Export failed");
        }
    }

    function exportGPX() {
        downloadFromEndpoint(
            `${getApiBase()}/export/gpx?raceId=${encodeURIComponent(raceId)}`,
            `finntrack_${raceId}.gpx`
        );
    }

    function exportKML() {
        downloadFromEndpoint(
            `${getApiBase()}/export/kml?raceId=${encodeURIComponent(raceId)}`,
            `finntrack_${raceId}.kml`
        );
    }

    function exportJSON(boats) {
        const payload = {
            raceId,
            exportedAt: new Date().toISOString(),
            boats: boats
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `finntrack_${raceId}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    // Public API
    return {
        getRaceId,
        setRaceId,
        loadRaceList,
        loadCourseData,
        loadReplayData,
        loadBoatsSnapshot,
        connectLive,
        disconnectLive,
        isConnected,
        exportGPX,
        exportKML,
        exportJSON
    };
})();
