import { Incident, Location, User } from '../types';

export function haversineKm(a: Location, b: Location): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface ResolvedHospital {
  id?: string;
  name: string;
  location?: Location;
}

/** Destination hospital for an incident: registry record first,
 *  then the exact GPS + name stored when a real nearby facility was chosen. */
export function getSelectedHospital(incident: Incident, users: User[] = []): ResolvedHospital | null {
  if (!incident?.selectedHospitalId && !(incident as any)?.selectedHospitalName) return null;
  const u = (users || []).find((x: any) => x.id === incident.selectedHospitalId);
  return {
    id: incident.selectedHospitalId,
    name: (incident as any).selectedHospitalName || (u as any)?.name || 'Emergency Hospital',
    location: (incident as any).selectedHospitalLocation || (u as any)?.location,
  };
}

export interface NearbyHospital {
  id: string;
  name: string;
  location: Location;
  distanceKm: number;
  source: 'RESQ' | 'OSM';
  emergency?: boolean;
  phone?: string | null;
  capacity?: { erBeds: number; icuBeds: number; ventilators: number } | null;
}

/** Real hospitals within radiusKm of the patient's GPS (server queries
 *  OpenStreetMap; falls back to the RESQ registry when OSM is unreachable). */
export async function fetchNearbyHospitals(
  lat: number,
  lng: number,
  radiusKm = 30
): Promise<{ hospitals: NearbyHospital[]; source: string }> {
  const r = await fetch(
    `/api/hospitals/nearby?lat=${lat}&lng=${lng}&radiusKm=${radiusKm}`
  );
  if (!r.ok) throw new Error('nearby hospital search failed');
  const j = await r.json();
  return { hospitals: j.hospitals || [], source: j.source || '' };
}
