///////////////////////////////////////////////////////////////
// FinnTrack API Module
// WebSocket connections, fetch calls, exports
///////////////////////////////////////////////////////////////

const FinnTrackAPI = (function() {
    let ws = null;
    let raceId = "RACE1";
    let onMessageCallback = null;
    let onCloseCallback = null;

    // Get/Set race ID
    function getRaceId() { return raceId; }
    function setRaceId(id) { raceId = id; }

    // Load race list from server
    async function loadRaceList() {
        const res = await fetch("/race/list");
        if (!res.ok) return [];
        const json = await res.json();
        return json.races || [];
    }

    // Load course data (start line, finish line, marks, polygon, wind)
    async function loadCourseData() {
        const res = await fetch(`/autocourse?raceId=${encodeURIComponent(raceId)}`);
        if (!res.ok) return null;
        return await res.json();
    }

    // Load replay data
    async function loadReplayData() {
        const res = await fetch(`/replay-multi?raceId=${encodeURIComponent(raceId)}`);
        if (!res.ok) return null;
        return await res.json();
    }

    // Load current boats snapshot
    async function loadBoatsSnapshot() {
        const res = await fetch(`/boats?raceId=${encodeURIComponent(raceId)}`);
        if (!res.ok) return null;
        return await res.json();
    }

    // WebSocket connection for live updates
    function connectLive(onMessage, onClose) {
        onMessageCallback = onMessage;
        onCloseCallback = onClose;

        if (ws) { ws.close(); ws = null; }

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}/live?raceId=${encodeURIComponent(raceId)}`);

        ws.onmessage = (evt) => {
            const msg = JSON.parse(evt.data);
            if (onMessageCallback) onMessageCallback(msg);
        };

        ws.onclose = () => {
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
    }

    function exportGPX() {
        downloadFromEndpoint(
            `/export/gpx?raceId=${encodeURIComponent(raceId)}`,
            `finntrack_${raceId}.gpx`
        );
    }

    function exportKML() {
        downloadFromEndpoint(
            `/export/kml?raceId=${encodeURIComponent(raceId)}`,
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
