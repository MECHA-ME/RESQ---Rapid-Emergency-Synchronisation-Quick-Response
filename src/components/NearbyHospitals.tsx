import React, { useEffect, useRef, useState } from 'react';
import { Incident } from '../types';
import { MapPin, Satellite, Navigation, BedDouble, CheckCircle2, Clock } from 'lucide-react';
import { NearbyHospital, fetchNearbyHospitals } from '../utils/hospital';

interface NearbyHospitalsProps {
  incident: Incident;
  radiusKm?: number;
  /** Driver mode: allow Select & Route (external OSM directly, RESQ units after accept). */
  selectable?: boolean;
  onSelect?: (h: NearbyHospital) => void;
  onSatelliteView?: (h: NearbyHospital) => void;
  /** Lift the resolved list up (e.g. so the parent map can pin every hospital). */
  onLoaded?: (hospitals: NearbyHospital[]) => void;
}

export default function NearbyHospitals({
  incident,
  radiusKm = 30,
  selectable = false,
  onSelect,
  onSatelliteView,
  onLoaded,
}: NearbyHospitalsProps) {
  const [hospitals, setHospitals] = useState<NearbyHospital[]>([]);
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  const lat = incident.location?.lat;
  const lng = incident.location?.lng;
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    fetchNearbyHospitals(lat, lng, radiusKm)
      .then(({ hospitals: list, source: src }) => {
        if (cancelled) return;
        setHospitals(list);
        setSource(src);
        setLoading(false);
        onLoadedRef.current?.(list);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('Hospital search is busy — the map database is rate-limited right now.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lng, radiusKm, reloadNonce]);

  const acceptedIds: string[] = (incident as any).acceptedHospitals || [];
  const selectedId: string | undefined = (incident as any).selectedHospitalId;

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-black uppercase text-gray-800 tracking-wide flex items-center gap-1.5">
          <MapPin size={14} className="text-emerald-600" />
          <span>Hospitals within {radiusKm} km of patient (GPS)</span>
        </span>
        <span className="text-[9px] font-mono font-bold text-slate-500 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded-full shrink-0">
          {loading ? 'SCANNING…' : `${hospitals.length} FOUND`}
        </span>
      </div>

      {loading && (
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-center animate-pulse">
          🛰 Scanning real hospitals around {typeof lat === 'number' ? `${lat.toFixed(4)}, ${lng!.toFixed(4)}` : 'patient GPS'}…
        </p>
      )}

      {!loading && loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-center space-y-2">
          <p className="text-xs text-red-600 font-semibold">{loadError}</p>
          <button
            onClick={() => setReloadNonce((n) => n + 1)}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-500 active:scale-95 text-white rounded-lg text-[11px] font-black transition-all"
          >
            ↻ RETRY SEARCH
          </button>
        </div>
      )}

      {!loading && !loadError && hospitals.length === 0 && (
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-center">
          No mapped hospitals within {radiusKm} km — widen search or use driver discretion.
        </p>
      )}

      <div className="space-y-2 max-h-[320px] overflow-y-auto pr-0.5">
        {hospitals.map((h) => {
          const isSelected = selectedId === h.id;
          const isResq = h.source === 'RESQ';
          const isAccepted = isResq ? acceptedIds.includes(h.id) : true;
          const canSelect = selectable && !isSelected && isAccepted;
          return (
            <div
              key={h.id}
              className={`p-3 rounded-xl border flex items-center justify-between gap-2 transition-all ${
                isSelected
                  ? 'border-emerald-600 bg-emerald-600 text-white shadow-md'
                  : 'border-gray-200 bg-white'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className={`text-xs font-black truncate ${isSelected ? 'text-white' : 'text-gray-900'}`}>
                    {h.name}
                  </p>
                  {h.emergency && (
                    <span className={`px-1.5 py-0.2 rounded text-[9px] font-black ${isSelected ? 'bg-white text-emerald-700' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                      ER 24/7
                    </span>
                  )}
                </div>
                <div className={`flex items-center gap-2 mt-1 text-[11px] font-semibold ${isSelected ? 'text-emerald-100' : 'text-gray-500'}`}>
                  <span className="flex items-center gap-1 font-mono font-bold">
                    <Navigation size={11} className={isSelected ? 'text-white' : 'text-emerald-600'} />
                    {h.distanceKm.toFixed(1)} km
                  </span>
                  <span className={`px-1.5 py-0.2 rounded text-[9px] font-black ${isSelected ? 'bg-white/20 text-white' : h.source === 'RESQ' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-slate-100 text-slate-600 border border-slate-200'}`}>
                    {h.source === 'RESQ' ? 'RESQ LIVE' : 'MAP DATA'}
                  </span>
                  {isResq && h.capacity && (
                    <span className="flex items-center gap-1">
                      <BedDouble size={11} />
                      ER {h.capacity.erBeds} · ICU {h.capacity.icuBeds}
                    </span>
                  )}
                </div>
                {isResq && !isAccepted && !isSelected && (
                  <p className="text-[10px] text-amber-600 font-bold mt-1 flex items-center gap-1">
                    <Clock size={10} /> Awaiting triage reply…
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5 shrink-0">
                {isSelected ? (
                  <span className="px-3 py-1.5 bg-white text-emerald-700 font-black rounded-lg text-[11px] flex items-center gap-1">
                    <CheckCircle2 size={13} /> Selected
                  </span>
                ) : (
                  <>
                    {canSelect && (
                      <button
                        onClick={() => onSelect?.(h)}
                        className="px-3 py-1.5 min-h-[40px] bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-black rounded-lg text-[11px] transition-all shadow-xs"
                      >
                        Select & Route
                      </button>
                    )}
                    {onSatelliteView && (
                      <button
                        onClick={() => onSatelliteView(h)}
                        title="View on satellite map"
                        className={`px-3 py-1.5 rounded-lg text-[11px] font-black flex items-center justify-center gap-1 transition-all active:scale-95 ${
                          isSelected
                            ? 'bg-white/20 text-white hover:bg-white/30'
                            : 'bg-slate-900 text-white hover:bg-slate-700'
                        }`}
                      >
                        <Satellite size={12} />
                        <span>Satellite</span>
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!loading && source !== '' && (
        <p className="text-[10px] text-gray-400 font-mono text-center">
          Source: {source} • distances from patient GPS • road route via OSRM
        </p>
      )}
    </div>
  );
}
