///////////////////////////////////////////////////////////////
// FinnTrack Map Module
// Leaflet map, boat markers, course layers, visualization
///////////////////////////////////////////////////////////////

const FinnTrackMap = (function() {
    let map = null;

    // Boat layers
    const boatMarkers = {};
    const boatLabels = {};
    const boatVectors = {};
    const boatPolylines = {};
    const boatColors = {};

    // Course layers
    let startLineLayer = null;
    let finishLineLayer = null;
    let markLayers = [];
    let polygonLayer = null;
    let windDirection = null;

    // Display options
    let showLabels = true;
    let showVectors = true;
    let showTrails = true;

    // Initialize map
    function initMap(elementId, center = [-41.2, 173.0], zoom = 11) {
        map = L.map(elementId, { zoomControl: true, preferCanvas: true }).setView(center, zoom);

        // Light theme tiles (OSM)
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            opacity: 1,
            attribution: "© OpenStreetMap"
        }).addTo(map);

        return map;
    }

    function getMap() { return map; }

    // Generate consistent color for boat
    function getBoatColor(id) {
        if (boatColors[id]) return boatColors[id];
        // Hash the ID for consistent color
        let hash = 0;
        for (let i = 0; i < id.length; i++) {
            hash = id.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = Math.abs(hash) % 360;
        boatColors[id] = `hsl(${h}, 70%, 45%)`;
        return boatColors[id];
    }

    // Clear all boat layers
    function clearBoatLayers() {
        for (const m of Object.values(boatMarkers)) map.removeLayer(m);
        for (const l of Object.values(boatLabels)) map.removeLayer(l);
        for (const v of Object.values(boatVectors)) map.removeLayer(v);
        for (const p of Object.values(boatPolylines)) map.removeLayer(p);

        for (const k in boatMarkers) delete boatMarkers[k];
        for (const k in boatLabels) delete boatLabels[k];
        for (const k in boatVectors) delete boatVectors[k];
        for (const k in boatPolylines) delete boatPolylines[k];
    }

    // Clear course layers
    function clearCourseLayers() {
        if (startLineLayer) map.removeLayer(startLineLayer);
        if (finishLineLayer) map.removeLayer(finishLineLayer);
        if (polygonLayer) map.removeLayer(polygonLayer);
        markLayers.forEach(m => map.removeLayer(m));

        startLineLayer = null;
        finishLineLayer = null;
        polygonLayer = null;
        markLayers = [];
    }

    // Render course layers from data
    function renderCourseLayers(data) {
        clearCourseLayers();

        if (!data) return;

        windDirection = data.windDirection ?? null;

        // Start line
        if (data.startLine?.A && data.startLine?.B) {
            const A = data.startLine.A, B = data.startLine.B;
            startLineLayer = L.polyline([[A[0], A[1]], [B[0], B[1]]], {
                color: "#0077cc",
                weight: 4,
                opacity: 0.9
            }).addTo(map);
        }

        // Finish line
        if (data.finishLine?.A && data.finishLine?.B) {
            const A = data.finishLine.A, B = data.finishLine.B;
            finishLineLayer = L.polyline([[A[0], A[1]], [B[0], B[1]]], {
                color: "#00a86b",
                weight: 4,
                opacity: 0.9
            }).addTo(map);
        }

        // Marks
        if (Array.isArray(data.marks)) {
            data.marks.forEach(pt => {
                const m = L.circleMarker([pt[0], pt[1]], {
                    radius: 8,
                    color: "#ff6b35",
                    fillColor: "#ff6b35",
                    fillOpacity: 0.9
                }).addTo(map);
                markLayers.push(m);
            });
        }

        // Course polygon
        if (Array.isArray(data.coursePolygon) && data.coursePolygon.length >= 3) {
            polygonLayer = L.polygon(data.coursePolygon.map(pt => [pt[0], pt[1]]), {
                color: "#663399",
                weight: 2,
                fillOpacity: 0.08
            }).addTo(map);
            map.fitBounds(polygonLayer.getBounds());
        }

        return { windDirection };
    }

    // Update or create boat marker
    function updateBoat(boatId, frame, options = {}) {
        if (!frame) return;

        const color = getBoatColor(boatId);
        const lat = frame.lat;
        const lng = frame.lng;

        // Main marker
        if (!boatMarkers[boatId]) {
            boatMarkers[boatId] = L.circleMarker([lat, lng], {
                radius: 6,
                color: color,
                fillColor: color,
                fillOpacity: 1
            }).addTo(map);

            if (options.onClick) {
                boatMarkers[boatId].on("click", () => options.onClick(boatId));
            }
        } else {
            boatMarkers[boatId].setLatLng([lat, lng]);
        }

        // Label
        if (showLabels) {
            const lblHtml = `<div style="color:${color};font-size:11px;font-weight:600;text-shadow:1px 1px 2px white;">${boatId}</div>`;
            if (!boatLabels[boatId]) {
                boatLabels[boatId] = L.marker([lat, lng], {
                    icon: L.divIcon({ html: lblHtml, className: "boatLabel", iconSize: [50, 20] }),
                    interactive: false
                }).addTo(map);
            } else {
                boatLabels[boatId].setLatLng([lat, lng]);
                boatLabels[boatId].setIcon(L.divIcon({ html: lblHtml, className: "boatLabel", iconSize: [50, 20] }));
            }
        }

        // Speed vector
        if (showVectors) {
            const heading = Number(frame.heading || 0);
            const spd = Number(frame.speed || 0);
            const len = Math.max(0.00005, spd * 0.00005);
            const lat2 = lat + Math.cos((heading * Math.PI) / 180) * len;
            const lng2 = lng + Math.sin((heading * Math.PI) / 180) * len;

            if (!boatVectors[boatId]) {
                boatVectors[boatId] = L.polyline([[lat, lng], [lat2, lng2]], {
                    color: color,
                    weight: 3,
                    opacity: 0.8
                }).addTo(map);
            } else {
                boatVectors[boatId].setLatLngs([[lat, lng], [lat2, lng2]]);
            }
        }

        // Trail
        if (showTrails) {
            if (!boatPolylines[boatId]) {
                boatPolylines[boatId] = L.polyline([[lat, lng]], {
                    color: color,
                    weight: 2,
                    opacity: 0.5
                }).addTo(map);
            } else if (options.appendTrail) {
                boatPolylines[boatId].addLatLng([lat, lng]);
            }
        }
    }

    // Set full trail for replay mode
    function setBoatTrail(boatId, frames) {
        const color = getBoatColor(boatId);
        if (boatPolylines[boatId]) {
            map.removeLayer(boatPolylines[boatId]);
        }
        boatPolylines[boatId] = L.polyline(frames.map(f => [f.lat, f.lng]), {
            color: color,
            weight: 2,
            opacity: 0.35
        }).addTo(map);
    }

    // Focus on a boat
    function focusBoat(boatId, zoom = 15) {
        const m = boatMarkers[boatId];
        if (m) {
            map.setView(m.getLatLng(), zoom, { animate: true });
        }
    }

    // Highlight a boat (dim others)
    function highlightBoat(boatId) {
        for (const b in boatMarkers) {
            const on = (b === boatId);
            boatMarkers[b].setStyle({ opacity: on ? 1 : 0.3, fillOpacity: on ? 1 : 0.3 });

            if (boatLabels[b] && boatLabels[b]._icon) {
                boatLabels[b]._icon.style.opacity = on ? "1" : "0.25";
            }
            if (boatVectors[b]) boatVectors[b].setStyle({ opacity: on ? 0.8 : 0.2 });
            if (boatPolylines[b]) boatPolylines[b].setStyle({ opacity: on ? 0.5 : 0.1 });
        }
    }

    // Reset highlight (show all)
    function resetHighlight() {
        for (const b in boatMarkers) {
            boatMarkers[b].setStyle({ opacity: 1, fillOpacity: 1 });
            if (boatLabels[b] && boatLabels[b]._icon) {
                boatLabels[b]._icon.style.opacity = "1";
            }
            if (boatVectors[b]) boatVectors[b].setStyle({ opacity: 0.8 });
            if (boatPolylines[b]) boatPolylines[b].setStyle({ opacity: 0.35 });
        }
    }

    // Show popup for boat
    function showBoatPopup(boatId, frame) {
        const m = boatMarkers[boatId];
        if (!m || !frame) return;

        const html = `
            <b>${boatId}</b><br>
            Lat: ${frame.lat.toFixed(6)}<br>
            Lng: ${frame.lng.toFixed(6)}<br>
            Speed: ${Number(frame.speed || 0).toFixed(1)} kn<br>
            Heading: ${Number(frame.heading || 0).toFixed(0)}°<br>
            ${frame.timestamp ? `Time: ${new Date(frame.timestamp * 1000).toLocaleTimeString()}` : ''}
        `;

        L.popup().setLatLng([frame.lat, frame.lng]).setContent(html).openOn(map);
    }

    // Fit map to all boats
    function fitToBounds() {
        const allPts = [];
        Object.values(boatPolylines).forEach(poly => {
            allPts.push(...poly.getLatLngs());
        });
        if (allPts.length) map.fitBounds(allPts);
    }

    // Toggle visibility functions
    function setLabelsVisible(visible) {
        showLabels = visible;
        for (const b in boatLabels) {
            if (boatLabels[b] && boatLabels[b]._icon) {
                boatLabels[b]._icon.style.display = visible ? "block" : "none";
            }
        }
    }

    function setVectorsVisible(visible) {
        showVectors = visible;
        for (const b in boatVectors) {
            if (boatVectors[b]) {
                visible ? boatVectors[b].addTo(map) : map.removeLayer(boatVectors[b]);
            }
        }
    }

    function setTrailsVisible(visible) {
        showTrails = visible;
        for (const b in boatPolylines) {
            if (boatPolylines[b]) {
                visible ? boatPolylines[b].addTo(map) : map.removeLayer(boatPolylines[b]);
            }
        }
    }

    function setStartLineVisible(visible) {
        if (startLineLayer) {
            visible ? startLineLayer.addTo(map) : map.removeLayer(startLineLayer);
        }
    }

    function setFinishLineVisible(visible) {
        if (finishLineLayer) {
            visible ? finishLineLayer.addTo(map) : map.removeLayer(finishLineLayer);
        }
    }

    function setMarksVisible(visible) {
        markLayers.forEach(m => visible ? m.addTo(map) : map.removeLayer(m));
    }

    function setPolygonVisible(visible) {
        if (polygonLayer) {
            visible ? polygonLayer.addTo(map) : map.removeLayer(polygonLayer);
        }
    }

    function getWindDirection() { return windDirection; }

    function getBoatIds() { return Object.keys(boatMarkers); }

    // Public API
    return {
        initMap,
        getMap,
        getBoatColor,
        clearBoatLayers,
        clearCourseLayers,
        renderCourseLayers,
        updateBoat,
        setBoatTrail,
        focusBoat,
        highlightBoat,
        resetHighlight,
        showBoatPopup,
        fitToBounds,
        setLabelsVisible,
        setVectorsVisible,
        setTrailsVisible,
        setStartLineVisible,
        setFinishLineVisible,
        setMarksVisible,
        setPolygonVisible,
        getWindDirection,
        getBoatIds
    };
})();
