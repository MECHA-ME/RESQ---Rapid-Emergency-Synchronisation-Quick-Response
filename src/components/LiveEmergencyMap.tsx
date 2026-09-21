import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Incident, UserRole, User } from '../types';
import { useLiveGeolocation } from '../utils/useLiveGeolocation';
import { 
  Navigation, 
  MapPin, 
  Truck, 
  Hospital as HospitalIcon, 
  ShieldAlert, 
  Radio, 
  Maximize2, 
  Minimize2, 
  Layers, 
  Compass,
  LocateFixed,
  Zap,
  Clock,
  Activity,
  CheckCircle2,
  AlertTriangle,
  RotateCcw
} from 'lucide-react';

interface LiveEmergencyMapProps {
  incident: Incident;
  role: UserRole;
  users?: User[];
  height?: string;
  showControls?: boolean;
  onCorridorAction?: (incidentId: string, action: 'ACKNOWLEDGE' | 'SYNC_ALL_GREEN' | 'DISPATCH_ESCORT') => void;
}

// Realistic San Francisco Emergency Route Coordinates
const ROUTE_PHASE_1_COORDS: [number, number][] = [
  [37.7879, -122.4075], // EMS Central Station (Mission & 4th)
  [37.7858, -122.4060], // 4th & Market St
  [37.7840, -122.4085], // 5th & Market St (Junction 1)
  [37.7820, -122.4110], // 6th & Market St
  [37.7802, -122.4135], // 7th & Market St (Junction 2)
  [37.7788, -122.4155], // 8th & Hyde St (Junction 3)
  [37.7793, -122.4162], // Patient Location: 1090 Market St (Civic Center)
];

const ROUTE_PHASE_2_COORDS: [number, number][] = [
  [37.7793, -122.4162], // Patient Location: 1090 Market St
  [37.7770, -122.4190], // 9th & Market St
  [37.7735, -122.4160], // 10th & Mission St
  [37.7695, -122.4115], // 13th & Division St (Express Ramp)
  [37.7650, -122.4070], // US-101 S Corridor Preempted Lane
  [37.7600, -122.4060], // Potrero Ave & 16th St
  [37.7570, -122.4055], // Potrero Ave & 20th St
  [37.7554, -122.4047], // SF General Trauma Center (ED Gate)
];

export default function LiveEmergencyMap({
  incident,
  role,
  users = [],
  height = '320px',
  showControls = true,
  onCorridorAction
}: LiveEmergencyMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layersRef = useRef<{
    tileLayer?: L.TileLayer;
    routePolyline?: L.Polyline;
    ambulanceMarker?: L.Marker;
    patientMarker?: L.Marker;
    hospitalMarker?: L.Marker;
    junctionMarkers?: L.Marker[];
    youMarker?: L.Marker;
    youCircle?: L.Circle;
  }>({});
  const [mapEpoch, setMapEpoch] = useState(0);
  const gpsCenteredRef = useRef<string | null>(null);

  // Exact device GPS — single shared watcher, shown as the "YOU" marker for the active role
  const { fix: deviceFix, error: gpsError } = useLiveGeolocation(true);
  const gpsLat = deviceFix?.lat;
  const gpsLng = deviceFix?.lng;
  const gpsAcc = deviceFix?.accuracy;

  // Tile stack: open OSM layers + optional satellite (Esri, free, credited on-layer)
  const [mapStyle, setMapStyle] = useState<'streets' | 'humanitarian' | 'tactical' | 'satellite'>('streets');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [simulationProgress, setSimulationProgress] = useState(0.4); // 0 to 1 along route
  const [isSimulating, setIsSimulating] = useState(true);

  // Determine current route phase
  const isPhase2 = incident.status === 'PATIENT_PICKED' || 
                   incident.status === 'IN_TRANSIT' || 
                   incident.status === 'REACHED_DESTINATION' || 
                   incident.status === 'COMPLETED';

  const activeRouteCoords = isPhase2 ? ROUTE_PHASE_2_COORDS : ROUTE_PHASE_1_COORDS;
  const responder = users.find(u => u.id === incident.assignedResponderId);
  const hospital = users.find(u => u.id === incident.selectedHospitalId);

  // Calculate vehicle position along route based on progress
  const getInterpolatedPosition = (coords: [number, number][], progress: number): [number, number] => {
    if (coords.length === 0) return [37.7793, -122.4162];
    if (progress <= 0) return coords[0];
    if (progress >= 1) return coords[coords.length - 1];

    const totalSegments = coords.length - 1;
    const segmentIndex = Math.floor(progress * totalSegments);
    const segmentFraction = (progress * totalSegments) - segmentIndex;

    const p1 = coords[segmentIndex];
    const p2 = coords[Math.min(segmentIndex + 1, coords.length - 1)];

    const lat = p1[0] + (p2[0] - p1[0]) * segmentFraction;
    const lng = p1[1] + (p2[1] - p1[1]) * segmentFraction;
    return [lat, lng];
  };

  const currentAmbulancePos = getInterpolatedPosition(activeRouteCoords, simulationProgress);

  // Real server-driven live GPS (computed from elapsed time + speed in /api/state).
  // Falls back to local simulation only when the server has no live position yet.
  const livePos: any = (incident as any).liveDriverPosition;
  const hasLiveTracking = !!(livePos && incident.assignedResponderId);
  // No unit accepted yet → searching state: show coverage, never a fake ambulance
  const hasResponder = !!incident.assignedResponderId;
  const liveProgress: number | undefined = livePos?.progress;
  const liveLat: number | undefined = livePos?.lat;
  const liveLng: number | undefined = livePos?.lng;

  // --- Street routing (OSRM, open source, no key) + smooth motion refs ---
  interface RoadRoute { pts: [number, number][]; cum: number[]; total: number; }
  const [road, setRoad] = useState<RoadRoute | null>(null);
  const roadKeyRef = useRef<string | null>(null);
  const targetRef = useRef<[number, number] | null>(null);
  const shownRef = useRef<[number, number] | null>(null);

  const haversineM = (a: [number, number], b: [number, number]): number => {
    const R = 6371000;
    const dLat = ((b[0] - a[0]) * Math.PI) / 180;
    const dLng = ((b[1] - a[1]) * Math.PI) / 180;
    const la1 = (a[0] * Math.PI) / 180;
    const la2 = (b[0] * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  const pointOnRoad = (r: RoadRoute, progress: number): [number, number] => {
    const target = Math.min(1, Math.max(0, progress)) * r.total;
    let i = 1;
    while (i < r.cum.length - 1 && r.cum[i] < target) i++;
    const segLen = r.cum[i] - r.cum[i - 1] || 1;
    const f = (target - r.cum[i - 1]) / segLen;
    const p1 = r.pts[i - 1];
    const p2 = r.pts[i];
    return [p1[0] + (p2[0] - p1[0]) * f, p1[1] + (p2[1] - p1[1]) * f];
  };

  // Route endpoints for street routing (server values first)
  const routeOrigin = livePos?.routeOrigin
    || (isPhase2 ? incident.location : responder?.location)
    || incident.location;
  const routeDest = livePos?.routeDestination
    || (isPhase2 ? hospital?.location : incident.location)
    || incident.location;
  const originKey = routeOrigin ? `${routeOrigin.lat?.toFixed(4)},${routeOrigin.lng?.toFixed(4)}` : 'none';
  const destKey = routeDest ? `${routeDest.lat?.toFixed(4)},${routeDest.lng?.toFixed(4)}` : 'none';

  // Fetch the real street path once per incident phase (cached, silent fallback)
  useEffect(() => {
    if (!incident.assignedResponderId || !routeOrigin || !routeDest) return;
    if (typeof routeOrigin.lat !== 'number' || typeof routeDest.lat !== 'number') return;
    const key = `${incident.id}|${isPhase2 ? 'p2' : 'p1'}|${originKey}|${destKey}`;
    if (roadKeyRef.current === key) return;
    let cancelled = false;
    fetch(`https://router.project-osrm.org/route/v1/driving/${routeOrigin.lng},${routeOrigin.lat};${routeDest.lng},${routeDest.lat}?overview=full&geometries=geojson`)
      .then(r => {
        if (!r.ok) throw new Error('osrm unavailable');
        return r.json();
      })
      .then(j => {
        if (cancelled) return;
        const coords = j?.routes?.[0]?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return;
        const pts = coords.map(([lng, lat]: number[]) => [lat, lng] as [number, number]);
        const cum: number[] = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1], pts[i]));
        roadKeyRef.current = key;
        setRoad({ pts, cum, total: cum[cum.length - 1] || 1 });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [incident.id, incident.assignedResponderId, isPhase2, originKey, destKey]);

  // Live simulation tick effect (local fallback only — server drives position when live)
  useEffect(() => {
    if (!isSimulating || hasLiveTracking) return;

    const interval = setInterval(() => {
      setSimulationProgress(prev => {
        if (prev >= 1) {
          return 0; // loop simulation
        }
        return Math.min(1, prev + 0.015);
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [isSimulating, hasLiveTracking]);

  // Sync progress bar with the server's real live position
  useEffect(() => {
    if (hasLiveTracking && typeof liveProgress === 'number') {
      setSimulationProgress(liveProgress);
    }
  }, [hasLiveTracking, liveProgress]);

  // Sync simulation progress with incident status
  useEffect(() => {
    switch (incident.status) {
      case 'RESPONDER_EN_ROUTE':
        setSimulationProgress(0.35);
        break;
      case 'HOSPITAL_SELECTED':
        setSimulationProgress(0.7);
        break;
      case 'PATIENT_PICKED':
        setSimulationProgress(0.1);
        break;
      case 'IN_TRANSIT':
        setSimulationProgress(0.55);
        break;
      case 'REACHED_DESTINATION':
      case 'COMPLETED':
        setSimulationProgress(1.0);
        break;
    }
  }, [incident.status]);

  // Initialize and Update Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    // Clean up existing map instance if container changed
    if (mapInstanceRef.current) {
      mapInstanceRef.current.remove();
      mapInstanceRef.current = null;
    }

    // Exact SOS location — the street-level anchor of the whole map
    const patientAnchor: [number, number] =
      incident.location && Number.isFinite(incident.location.lat) && Number.isFinite(incident.location.lng)
        ? [incident.location.lat, incident.location.lng]
        : [37.7793, -122.4162];

    // Focus: dispatched unit's real live GPS; otherwise the exact SOS spot (street level)
    const focusPos: [number, number] =
      incident.assignedResponderId
        ? (hasLiveTracking && typeof liveLat === 'number' && typeof liveLng === 'number'
            ? [liveLat, liveLng]
            : currentAmbulancePos)
        : patientAnchor;

    const map = L.map(mapContainerRef.current, {
      center: focusPos,
      zoom: 16,
      zoomControl: false,
      attributionControl: false
    });

    mapInstanceRef.current = map;
    shownRef.current = null;
    setMapEpoch(e => e + 1);

    // 100% open-source tile layers — all rendered from OpenStreetMap data:
    // - streets: OSM Standard | - humanitarian: OSM Humanitarian (HOT, built for disaster response)
    // - tactical: CARTO Voyager (OSM data, high-contrast ops view)
    const tileLayers = {
      streets: {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        maxZoom: 19,
      },
      humanitarian: {
        url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
        maxZoom: 19,
      },
      tactical: {
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        maxZoom: 20,
      },
      satellite: {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maxZoom: 19,
      },
    };

    const tileLayer = L.tileLayer(tileLayers[mapStyle].url, {
      maxZoom: tileLayers[mapStyle].maxZoom,
      crossOrigin: true
    }).addTo(map);

    layersRef.current.tileLayer = tileLayer;

    // 15 km search coverage ring while no unit has accepted yet (no fake route)
    if (!hasResponder) {
      L.circle(patientAnchor, {
        radius: 15000,
        color: '#f59e0b',
        weight: 1.5,
        opacity: 0.5,
        dashArray: '8, 8',
        fillColor: '#f59e0b',
        fillOpacity: 0.04,
      }).bindTooltip('Broadcasting SOS to units within 15 km').addTo(map);
    }

    // Route Polyline (Emergency Green Wave glow path) — only for an assigned unit
    const liveRoute: [number, number][] | null =
      hasLiveTracking && Array.isArray(livePos?.routeCoords) && livePos.routeCoords.length > 1
        ? livePos.routeCoords.map((p: any) => [p.lat, p.lng] as [number, number])
        : null;
    if (hasResponder) {
      const routePolyline = L.polyline(liveRoute || activeRouteCoords, {
        color: isPhase2 ? '#059669' : '#2563eb',
        weight: 6,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
        dashArray: '10, 8'
      }).addTo(map);

      layersRef.current.routePolyline = routePolyline;
    }

    // 1. Patient Marker — exact SOS location from the incident (never simulated)
    const patientPos: [number, number] = patientAnchor;
    const patientHtml = `
      <div class="relative flex items-center justify-center">
        <div class="absolute w-8 h-8 rounded-full bg-red-500/30 animate-ping"></div>
        <div class="w-8 h-8 rounded-full bg-red-600 border-2 border-white shadow-lg flex items-center justify-center text-white text-xs font-black">
          SOS
        </div>
        <div class="absolute -top-7 whitespace-nowrap px-2 py-0.5 rounded-full bg-slate-900/90 text-white text-[9px] font-bold shadow">
          Patient Location
        </div>
      </div>
    `;

    const patientIcon = L.divIcon({
      html: patientHtml,
      className: 'custom-patient-marker',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const patientMarker = L.marker(patientPos, { icon: patientIcon })
      .bindPopup(`<b>Incident Location</b><br/>${incident.address || '1090 Market St, SF'}`)
      .addTo(map);

    layersRef.current.patientMarker = patientMarker;

    // 2. Hospital Marker — exact facility location from the server user record
    const hospitalPos: [number, number] =
      hospital?.location && Number.isFinite(hospital.location.lat) && Number.isFinite(hospital.location.lng)
        ? [hospital.location.lat, hospital.location.lng]
        : [37.7554, -122.4047];
    const hospitalName = hospital?.name || 'SF General Trauma Center';
    const hospitalHtml = `
      <div class="relative flex items-center justify-center">
        <div class="w-8 h-8 rounded-xl bg-emerald-600 border-2 border-white shadow-lg flex items-center justify-center text-white text-xs font-black">
          H
        </div>
        <div class="absolute -top-7 whitespace-nowrap px-2 py-0.5 rounded-full bg-emerald-950 text-white text-[9px] font-bold shadow border border-emerald-500/40">
          ${hospitalName.split(' ')[0]} Hospital
        </div>
      </div>
    `;

    const hospitalIcon = L.divIcon({
      html: hospitalHtml,
      className: 'custom-hospital-marker',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const hospitalMarker = L.marker(hospitalPos, { icon: hospitalIcon })
      .bindPopup(`<b>${hospitalName}</b><br/>Level 1 Trauma Center • ER Active`)
      .addTo(map);

    layersRef.current.hospitalMarker = hospitalMarker;

    // 3. Traffic Preemption Junctions along route (assigned unit only)
    const junctions = incident.greenCorridor?.junctions || (hasResponder ? [
      { id: 'j-01', name: '5th & Market St', status: 'GREEN', etaSeconds: 30 },
      { id: 'j-02', name: '7th & Market St', status: 'GREEN', etaSeconds: 75 },
      { id: 'j-03', name: '8th & Hyde Intersect', status: 'CLEARING', etaSeconds: 120 },
    ] : []);

    const junctionCoords: [number, number][] = [
      [37.7840, -122.4085],
      [37.7802, -122.4135],
      [37.7788, -122.4155],
    ];

    const junctionMarkers: L.Marker[] = [];

    junctions.forEach((j, idx) => {
      if (idx < junctionCoords.length) {
        const jPos = junctionCoords[idx];
        const isGreen = j.status === 'GREEN';
        const jHtml = `
          <div class="relative flex flex-col items-center">
            <div class="w-5 h-5 rounded-full ${isGreen ? 'bg-emerald-500 shadow-emerald-500/50' : 'bg-amber-500 shadow-amber-500/50'} border-2 border-white shadow-md flex items-center justify-center text-white text-[8px] font-black">
              ${isGreen ? '🟢' : '🟡'}
            </div>
            <div class="whitespace-nowrap px-1.5 py-0.2 mt-0.5 rounded bg-slate-900/80 text-white text-[8px] font-bold">
              ${j.name.split('&')[0]}
            </div>
          </div>
        `;
        const jIcon = L.divIcon({
          html: jHtml,
          className: 'custom-junction-marker',
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        });
        const jMarker = L.marker(jPos, { icon: jIcon })
          .bindPopup(`<b>${j.name}</b><br/>Preemption: ${j.status}<br/>ETA: ${j.etaSeconds}s`)
          .addTo(map);
        junctionMarkers.push(jMarker);
      }
    });

    layersRef.current.junctionMarkers = junctionMarkers;

    // 4. Moving Ambulance Marker assets (placed on the map only once a real unit accepts)
    const responderName = responder?.name || 'Ambulance Unit 1';
    const ambulanceHtml = `
      <div class="relative flex items-center justify-center">
        <div class="absolute w-10 h-10 rounded-full bg-blue-500/30 animate-pulse"></div>
        <div class="w-9 h-9 rounded-full bg-slate-950 border-2 border-blue-400 shadow-xl flex items-center justify-center text-white text-xs font-bold ring-2 ring-red-500/80">
          🚑
        </div>
        <div class="absolute -top-7 whitespace-nowrap px-2 py-0.5 rounded-full bg-blue-600 text-white text-[9px] font-black shadow flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-white animate-ping"></span>
          ${responderName}
        </div>
      </div>
    `;

    const ambulanceIcon = L.divIcon({
      html: ambulanceHtml,
      className: 'custom-ambulance-marker',
      iconSize: [36, 36],
      iconAnchor: [18, 18]
    });

    // 4. Moving Ambulance Marker — only once a real unit has accepted
    if (hasResponder) {
      const ambulanceMarker = L.marker(focusPos, { icon: ambulanceIcon, zIndexOffset: 1000 })
        .bindPopup(`<b>${responderName}</b><br/>Status: ${incident.status}<br/>Speed: ${hasLiveTracking && livePos.speedKmH ? `${livePos.speedKmH} km/h` : '68 km/h'}${hasLiveTracking ? '<br/>Source: live GPS' : ''}`)
        .addTo(map);

      layersRef.current.ambulanceMarker = ambulanceMarker;
    }

    // Frame the incident area: fit the route only when it is local.
    // A cross-country span (e.g. demo unit vs real GPS) must never zoom out to a world map.
    try {
      const bounds = L.latLngBounds(liveRoute || activeRouteCoords);
      const span = Math.max(
        Math.abs(bounds.getNorth() - bounds.getSouth()),
        Math.abs(bounds.getEast() - bounds.getWest())
      );
      if (!incident.assignedResponderId || span > 1) {
        map.setView(patientAnchor, 16);
      } else {
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    } catch (e) {
      map.setView(patientAnchor, 16);
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [mapStyle, isPhase2]);

  // Redraw the route on real streets once OSRM geometry arrives (or map recreates)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !road || road.pts.length < 2) return;
    if (layersRef.current.routePolyline) {
      layersRef.current.routePolyline.remove();
      layersRef.current.routePolyline = undefined;
    }
    layersRef.current.routePolyline = L.polyline(road.pts, {
      color: isPhase2 ? '#059669' : '#2563eb',
      weight: 6,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(map);
  }, [road, mapEpoch, isPhase2]);

  // Steer the marker target: street geometry at server progress > raw GPS > simulation
  useEffect(() => {
    if (road && hasLiveTracking && typeof liveProgress === 'number') {
      targetRef.current = pointOnRoad(road, liveProgress);
    } else if (hasLiveTracking && typeof liveLat === 'number' && typeof liveLng === 'number') {
      targetRef.current = [liveLat, liveLng];
    } else {
      targetRef.current = currentAmbulancePos;
    }
  }, [simulationProgress, hasLiveTracking, liveLat, liveLng, liveProgress, road]);

  // Ease the marker toward its target every frame — smooth street glide, never a jump
  useEffect(() => {
    let raf = 0;
    const step = () => {
      const marker = layersRef.current.ambulanceMarker;
      const t = targetRef.current;
      if (marker && t) {
        const cur = shownRef.current ?? t;
        const nx = cur[0] + (t[0] - cur[0]) * 0.12;
        const ny = cur[1] + (t[1] - cur[1]) * 0.12;
        const next: [number, number] =
          Math.abs(t[0] - nx) + Math.abs(t[1] - ny) < 1e-7 ? t : [nx, ny];
        shownRef.current = next;
        marker.setLatLng(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mapEpoch]);

  // "YOU" marker — the active role's exact device GPS with accuracy circle
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (layersRef.current.youMarker) {
      layersRef.current.youMarker.remove();
      layersRef.current.youMarker = undefined;
    }
    if (layersRef.current.youCircle) {
      layersRef.current.youCircle.remove();
      layersRef.current.youCircle = undefined;
    }
    if (typeof gpsLat !== 'number' || typeof gpsLng !== 'number') return;

    const circle = L.circle([gpsLat, gpsLng], {
      radius: Math.max(gpsAcc || 0, 25),
      color: '#8b5cf6',
      weight: 1.5,
      opacity: 0.7,
      fillColor: '#8b5cf6',
      fillOpacity: 0.12,
    }).addTo(map);

    const youHtml = `
      <div class="relative flex items-center justify-center">
        <div class="absolute w-8 h-8 rounded-full bg-violet-500/30 animate-ping"></div>
        <div class="w-8 h-8 rounded-full bg-violet-600 border-2 border-white shadow-lg flex items-center justify-center text-white text-xs font-black">
          YOU
        </div>
        <div class="absolute -top-7 whitespace-nowrap px-2 py-0.5 rounded-full bg-violet-950 text-white text-[9px] font-bold shadow border border-violet-500/40">
          YOU • ${role}${gpsAcc ? ` • ±${Math.round(gpsAcc)}m` : ''}
        </div>
      </div>
    `;
    const youIcon = L.divIcon({
      html: youHtml,
      className: 'custom-you-marker',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
    const marker = L.marker([gpsLat, gpsLng], { icon: youIcon, zIndexOffset: 500 })
      .bindPopup(`<b>Your exact location (${role})</b><br/>${gpsLat.toFixed(5)}, ${gpsLng.toFixed(5)}`)
      .addTo(map);

    layersRef.current.youMarker = marker;
    layersRef.current.youCircle = circle;
    return () => {
      marker.remove();
      circle.remove();
    };
  }, [gpsLat, gpsLng, gpsAcc, role, mapEpoch]);

  // Center on exact GPS once it locks (only when no unit is dispatched yet)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || incident.assignedResponderId) return;
    if (typeof gpsLat !== 'number' || typeof gpsLng !== 'number') return;
    if (gpsCenteredRef.current === incident.id) return;
    gpsCenteredRef.current = incident.id;
    map.setView([gpsLat, gpsLng], 15, { animate: true });
  }, [gpsLat, gpsLng, incident.id, incident.assignedResponderId]);

  // Recenter helper
  const handleRecenter = () => {
    if (!mapInstanceRef.current) return;
    const target: [number, number] =
      hasLiveTracking && typeof liveLat === 'number' && typeof liveLng === 'number'
        ? [liveLat, liveLng]
        : currentAmbulancePos;
    mapInstanceRef.current.setView(target, 16, { animate: true });
  };

  // Jump to the user's real GPS position
  const handleLocateMe = () => {
    if (!mapInstanceRef.current || typeof gpsLat !== 'number' || typeof gpsLng !== 'number') return;
    mapInstanceRef.current.setView([gpsLat, gpsLng], 16, { animate: true });
  };

  // Street / Area / District / State zoom presets, kept on the current center
  const ZOOM_PRESETS: [string, number][] = [
    ['Street', 16],
    ['Area', 13],
    ['District', 11],
    ['State', 8],
  ];
  const handlePresetZoom = (zoom: number) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    map.setView(map.getCenter(), zoom, { animate: true });
  };

  // Fit incident area (never a world map — same span guard as init)
  const handleFitRoute = () => {
    if (!mapInstanceRef.current) return;
    const lp: any = (incident as any).liveDriverPosition;
    const pts: [number, number][] =
      lp && incident.assignedResponderId && Array.isArray(lp.routeCoords) && lp.routeCoords.length > 1
        ? lp.routeCoords.map((p: any) => [p.lat, p.lng] as [number, number])
        : activeRouteCoords;
    try {
      const bounds = L.latLngBounds(pts);
      const span = Math.max(
        Math.abs(bounds.getNorth() - bounds.getSouth()),
        Math.abs(bounds.getEast() - bounds.getWest())
      );
      const anchor: [number, number] =
        incident.location && Number.isFinite(incident.location.lat) && Number.isFinite(incident.location.lng)
          ? [incident.location.lat, incident.location.lng]
          : pts[0];
      if (!incident.assignedResponderId || span > 1) {
        mapInstanceRef.current.setView(anchor, 16, { animate: true });
      } else {
        mapInstanceRef.current.fitBounds(bounds, { padding: [30, 30] });
      }
    } catch (e) {
      // keep current view
    }
  };

  // Live stats — real server telemetry first, local estimate as fallback
  const liveSpeed = hasLiveTracking && typeof livePos?.speedKmH === 'number' ? livePos.speedKmH : null;
  const remainingDistanceKm = hasLiveTracking && typeof livePos?.remainingKm === 'number'
    ? livePos.remainingKm.toFixed(1)
    : ((1 - simulationProgress) * (isPhase2 ? 3.8 : 2.2)).toFixed(1);
  const remainingMinutesRaw = hasLiveTracking && typeof livePos?.remainingSeconds === 'number'
    ? Math.max(1, Math.ceil(livePos.remainingSeconds / 60))
    : Math.max(1, Math.ceil(Number(remainingDistanceKm) * 1.5));
  // Human-readable ETA — never absurd: minutes under 2h, hours beyond that
  const etaLabel = !Number.isFinite(remainingMinutesRaw)
    ? '—'
    : remainingMinutesRaw < 120
      ? `~${remainingMinutesRaw} min`
      : `~${(remainingMinutesRaw / 60).toFixed(1)} h`;

  return (
    <div className={`relative isolate w-full rounded-2xl overflow-hidden border border-gray-200 shadow-md bg-slate-900 ${
      isFullscreen ? 'fixed inset-2 z-[9999] h-[calc(100vh-16px)]' : ''
    }`} style={{ height: isFullscreen ? 'auto' : height }}>
      
      {/* Top Telemetry & Direction Banner Overlay */}
      <div className="absolute top-2.5 left-2.5 right-2.5 z-[1000] flex flex-col gap-1.5 pointer-events-none">
        {/* Role-Specific Live HUD — searching state until a real unit accepts */}
        <div className="bg-slate-950/90 backdrop-blur-md text-white p-2.5 rounded-xl border border-white/15 shadow-xl flex items-center justify-between gap-2 pointer-events-auto">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
              !hasResponder ? 'bg-amber-500 text-white' : isPhase2 ? 'bg-emerald-600 text-white' : 'bg-blue-600 text-white'
            }`}>
              {!hasResponder ? <Radio size={16} /> : isPhase2 ? <HospitalIcon size={16} /> : <Truck size={16} />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] font-black uppercase tracking-wider ${!hasResponder ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {!hasResponder ? 'SEARCHING FOR UNITS' : isPhase2 ? 'PHASE 2: TO HOSPITAL' : 'PHASE 1: TO PATIENT'}
                </span>
                <span className={`w-1.5 h-1.5 rounded-full animate-ping ${!hasResponder ? 'bg-amber-400' : 'bg-emerald-500'}`}></span>
              </div>
              <p className="text-xs font-bold truncate text-white">
                {!hasResponder
                  ? 'SOS broadcast — waiting for acceptance'
                  : isPhase2
                    ? `Routing to ${hospital?.name || 'SF General Hospital'}`
                    : `Approaching ${incident.address || '1090 Market Street'}`}
              </p>
            </div>
          </div>

          <div className="text-right shrink-0">
            {!hasResponder ? (
              <>
                <div className="text-xs font-mono font-black text-amber-400">STANDBY</div>
                <div className="text-[10px] text-slate-400 font-mono">awaiting unit</div>
              </>
            ) : (
              <>
                <div className="text-xs font-mono font-black text-amber-400">
                  {etaLabel}
                </div>
                <div className="text-[10px] text-slate-400 font-mono">
                  {remainingDistanceKm} km left
                </div>
              </>
            )}
            <div className={`text-[9px] font-mono font-black ${hasLiveTracking ? 'text-emerald-400' : 'text-slate-500'}`}>
              {hasLiveTracking ? '● LIVE GPS' : '○ SIM'}
            </div>
          </div>
        </div>

        {/* Green Corridor Protection Notice for Traffic & Driver */}
        {incident.greenCorridor?.required && (
          <div className="bg-emerald-950/90 backdrop-blur-xs text-emerald-200 px-3 py-1 rounded-lg border border-emerald-500/30 text-[10px] font-bold flex items-center justify-between shadow pointer-events-auto">
            <span className="flex items-center gap-1.5">
              <Zap size={11} className="text-emerald-400 fill-current" />
              Green Corridor Active: Signals Preempted
            </span>
            <span className="text-emerald-300 font-mono">{liveSpeed ? `${liveSpeed} km/h • LIVE` : '68 km/h'}</span>
          </div>
        )}
      </div>

      {/* Map Canvas */}
      <div ref={mapContainerRef} className="w-full h-full min-h-[220px] bg-slate-900 z-10" />

      {/* Real-GPS status pill (above the test-slider row) */}
      <div className="absolute bottom-[54px] left-1/2 -translate-x-1/2 z-[990] pointer-events-none">
        <div className={`whitespace-nowrap px-2.5 py-1 rounded-full text-[9px] font-mono font-black border backdrop-blur-md ${
          deviceFix && deviceFix.accuracy > 2000
            ? 'bg-amber-950/85 text-amber-300 border-amber-500/40'
            : deviceFix
              ? 'bg-blue-950/85 text-blue-300 border-blue-500/40'
              : gpsError
                ? 'bg-red-950/85 text-red-300 border-red-500/40'
                : 'bg-slate-950/85 text-slate-400 border-white/15'
        }`}>
          {deviceFix && deviceFix.accuracy > 2000
            ? `● COARSE FIX ±${(deviceFix.accuracy / 1000).toFixed(0)}km — STEP OUTDOORS`
            : deviceFix
              ? `● YOU ±${Math.round(deviceFix.accuracy)}m REAL GPS`
              : gpsError
                ? `○ ${gpsError}`
                : '○ LOCATING YOU...'}
        </div>
      </div>

      {/* Bottom Floating Map Controls */}
      {showControls && (
        <div className="absolute bottom-2.5 right-2.5 z-[1000] flex flex-col gap-1.5">
          {/* Real location button */}
          <button
            onClick={handleLocateMe}
            disabled={!deviceFix}
            className={`w-8 h-8 rounded-lg shadow-lg border flex items-center justify-center transition-transform active:scale-90 ${
              deviceFix
                ? 'bg-blue-600 hover:bg-blue-500 text-white border-blue-400/50 cursor-pointer'
                : 'bg-white/60 text-slate-400 border-gray-200 cursor-not-allowed'
            }`}
            title={deviceFix ? `Jump to your real location (±${Math.round(deviceFix.accuracy)}m)` : (gpsError || 'Waiting for device GPS...')}
          >
            <LocateFixed size={16} />
          </button>
          {/* Recenter button */}
          <button
            onClick={handleRecenter}
            className="w-8 h-8 rounded-lg bg-white hover:bg-slate-100 text-slate-800 shadow-lg border border-gray-200 flex items-center justify-center transition-transform active:scale-90 cursor-pointer"
            title="Recenter on Ambulance"
          >
            <Compass size={16} />
          </button>

          {/* Fit Route button */}
          <button
            onClick={handleFitRoute}
            className="w-8 h-8 rounded-lg bg-white hover:bg-slate-100 text-slate-800 shadow-lg border border-gray-200 flex items-center justify-center transition-transform active:scale-90 cursor-pointer"
            title="View Entire Route"
          >
            <Navigation size={15} />
          </button>

          {/* Map style toggle */}
          <button
            onClick={() => setMapStyle(prev => prev === 'streets' ? 'humanitarian' : prev === 'humanitarian' ? 'tactical' : prev === 'tactical' ? 'satellite' : 'streets')}
            className="w-8 h-8 rounded-lg bg-white hover:bg-slate-100 text-slate-800 shadow-lg border border-gray-200 flex items-center justify-center transition-transform active:scale-90 cursor-pointer"
            title={`Layer: ${mapStyle === 'streets' ? 'Standard' : mapStyle === 'humanitarian' ? 'Humanitarian' : mapStyle === 'tactical' ? 'Tactical' : 'Satellite'} — tap to switch`}
          >
            <Layers size={15} />
          </button>

          {/* Fullscreen toggle */}
          <button
            onClick={() => setIsFullscreen(prev => !prev)}
            className="w-8 h-8 rounded-lg bg-white hover:bg-slate-100 text-slate-800 shadow-lg border border-gray-200 flex items-center justify-center transition-transform active:scale-90 cursor-pointer"
            title={isFullscreen ? "Exit Fullscreen" : "Expand Map"}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      )}

      {/* Bottom-Left Quick Action for Traffic Police Role */}
      {role === 'TRAFFIC_POLICE' && onCorridorAction && hasResponder && incident.greenCorridor && (
        <div className="absolute bottom-2.5 left-2.5 z-[1000] flex items-center gap-1.5">
          <button
            onClick={() => onCorridorAction(incident.id, 'SYNC_ALL_GREEN')}
            className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white rounded-lg text-[10px] font-black shadow-lg flex items-center gap-1 cursor-pointer transition-all border border-emerald-400/40"
          >
            <Zap size={11} className="fill-current" />
            <span>Force 100% Green</span>
          </button>
        </div>
      )}

      {/* Satellite imagery credit (shown only on the satellite layer, per Esri terms) */}
      {mapStyle === 'satellite' && (
        <div className={`absolute left-2.5 z-[990] pointer-events-none text-[8px] font-mono text-white/80 bg-black/55 px-1.5 py-0.5 rounded ${hasResponder ? 'bottom-[64px]' : 'bottom-2.5'}`}>
          Imagery © Esri, Maxar, Earthstar Geographics
        </div>
      )}

      {/* Bottom-Center Zoom Presets: Street / Area / District / State */}
      <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-[1000] bg-slate-950/85 backdrop-blur-xs border border-white/10 rounded-full px-1 py-1 flex items-center gap-0.5 shadow-lg">
        {ZOOM_PRESETS.map(([label, zoom]) => (
          <button
            key={label}
            onClick={() => handlePresetZoom(zoom)}
            className="px-2 py-1 text-[9px] font-black uppercase tracking-wide text-slate-300 hover:text-white hover:bg-white/10 rounded-full transition-all cursor-pointer active:scale-95"
            title={`Zoom to ${label} level`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Bottom-Left Live Progress Slider — only meaningful once a unit is en route */}
      {hasResponder && (
      <div className="absolute bottom-2.5 left-2.5 z-[990] bg-slate-950/80 backdrop-blur-xs px-2 py-1 rounded-lg border border-white/10 text-white flex items-center gap-2 max-w-[170px]">
        <button
          onClick={() => setIsSimulating(p => !p)}
          className="text-[9px] font-bold text-slate-300 hover:text-white"
          title="Play/Pause Movement Simulation"
        >
          {isSimulating ? '⏸' : '▶'}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={simulationProgress}
          onChange={(e) => {
            setIsSimulating(false);
            setSimulationProgress(parseFloat(e.target.value));
          }}
          className="w-16 h-1 bg-slate-700 rounded-lg accent-emerald-500 cursor-pointer"
          title="Drag to simulate ambulance moving along route"
        />
        <span className="text-[9px] font-mono text-emerald-400">
          {Math.round(simulationProgress * 100)}%
        </span>
      </div>
      )}

    </div>
  );
}
