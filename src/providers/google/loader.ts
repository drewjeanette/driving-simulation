/**
 * Loads the Maps JavaScript API once, using Google's dynamic library import
 * (`google.maps.importLibrary`). Written out here rather than pasted as the
 * minified bootstrap so it is readable and passes lint.
 */
let loading: Promise<void> | null = null;

declare global {
  interface Window {
    __gmapsAuthFailed?: () => void;
    gm_authFailure?: () => void;
  }
}

export function loadGoogleMaps(apiKey: string): Promise<void> {
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    if (typeof window.google !== 'undefined' && 'importLibrary' in (window.google.maps ?? {})) {
      resolve();
      return;
    }
    const callback = `__gmapsReady_${Math.random().toString(36).slice(2)}`;
    (window as unknown as Record<string, unknown>)[callback] = () => resolve();
    // Google calls this global when the key is rejected (bad key, referrer
    // not allowed, billing disabled). Surface it instead of failing silently.
    window.gm_authFailure = () => {
      window.__gmapsAuthFailed?.();
      reject(
        new Error('Google Maps rejected the API key. Check its referrer and API restrictions.'),
      );
    };
    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      libraries: 'places,geometry,routes',
      callback,
      loading: 'async',
    });
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => reject(new Error('Could not load Google Maps. Check your connection.'));
    document.head.append(script);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
