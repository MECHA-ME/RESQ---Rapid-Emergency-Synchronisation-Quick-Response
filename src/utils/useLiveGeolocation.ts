import { useEffect, useState } from 'react';

export interface GpsFix {
  lat: number;
  lng: number;
  /** Accuracy radius in meters (as reported by the device). */
  accuracy: number;
  at: number;
}

/**
 * Live device GPS via the browser Geolocation API (open web standard, no keys).
 * Works on localhost and HTTPS. Returns null fix until permission is granted.
 */
export function useLiveGeolocation(enabled = true) {
  const [fix, setFix] = useState<GpsFix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  // Bumped by retry() to restart the watcher (e.g. after the user grants
  // permission in a second attempt). Each tunnel URL is a new browser origin,
  // so permission must be granted again for every new public link.
  const [attempt, setAttempt] = useState(0);
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  useEffect(() => {
    if (!enabled || !supported) return;
    let watchId: number | null = null;
    try {
      watchId = navigator.geolocation.watchPosition(
        (p) => {
          setFix({
            lat: p.coords.latitude,
            lng: p.coords.longitude,
            accuracy: p.coords.accuracy,
            at: Date.now(),
          });
          setError(null);
          setErrorCode(null);
        },
        (e: any) => {
          setErrorCode(typeof e?.code === 'number' ? e.code : null);
          setError(
            e?.code === 1
              ? 'Location permission denied — allow location for this site, then tap Retry'
              : e?.message || 'GPS unavailable'
          );
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    } catch (e: any) {
      setError(e?.message || 'GPS unavailable');
    }
    return () => {
      if (watchId != null) navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled, supported, attempt]);

  const retry = () => {
    setError(null);
    setErrorCode(null);
    setAttempt((a) => a + 1);
  };

  return { fix, error, errorCode, supported, retry };
}
