import { LatLng } from '../../geo/geo';
import { fetchJson } from '../types';

/**
 * OpenStreetMap features around a stretch of route, from the free Overpass
 * API: building footprints with heights, the street network, green spaces,
 * trees, stop signs and traffic signals. This is what the 3D city is built
 * from.
 */
const OVERPASS = 'https://overpass-api.de/api/interpreter';

export interface OsmBuilding {
  id: number;
  outline: LatLng[];
  /** Height of the roof edge above ground, m. */
  height: number;
  /** Height where the building starts (for overhangs/bridges), m. */
  minHeight: number;
  kind: string;
  roofShape: string | null;
  colour: string | null;
}

export interface OsmRoad {
  id: number;
  line: LatLng[];
  kind: string;
  /** Carriageway width, m. */
  width: number;
}

export interface OsmArea {
  id: number;
  kind: 'grass' | 'park' | 'forest' | 'water' | 'parking';
  outline: LatLng[];
}

export interface OsmPoint {
  id: number;
  kind: 'tree' | 'traffic_signals' | 'stop' | 'give_way';
  at: LatLng;
  /** "forward" / "backward" relative to the way, when mapped. */
  direction: string | null;
}

export interface OsmFeatures {
  buildings: OsmBuilding[];
  roads: OsmRoad[];
  areas: OsmArea[];
  points: OsmPoint[];
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
}

/** Parses OSM length values: "12", "12 m", "12.5m", "40'" or "40 ft". */
export function parseLength(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|ft|'|feet)?\s*$/i.exec(v.replace(',', '.'));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] && /ft|'|feet/i.test(m[2]) ? n * 0.3048 : n;
}

const LEVEL_HEIGHT = 3.1;

/** Typical heights when a building has no height or level tags. */
const DEFAULT_LEVELS: Record<string, number> = {
  house: 2,
  detached: 2,
  semidetached_house: 2,
  terrace: 2,
  bungalow: 1,
  residential: 2,
  apartments: 4,
  garage: 1,
  garages: 1,
  shed: 1,
  carport: 1,
  roof: 1,
  commercial: 2,
  retail: 1,
  supermarket: 1,
  industrial: 2,
  warehouse: 2,
  office: 4,
  hotel: 5,
  church: 3,
  school: 2,
  hospital: 4,
  yes: 2,
};

export function buildingHeight(tags: Record<string, string>): {
  height: number;
  minHeight: number;
} {
  const kind = tags.building ?? 'yes';
  const levels = Number(tags['building:levels']);
  const roofLevels = Number(tags['roof:levels']) || 0;
  let height = parseLength(tags.height);
  if (height === null && Number.isFinite(levels) && levels > 0) {
    height = (levels + roofLevels * 0.5) * LEVEL_HEIGHT + 0.6;
  }
  if (height === null) height = (DEFAULT_LEVELS[kind] ?? 2) * LEVEL_HEIGHT + 0.6;
  let minHeight = parseLength(tags.min_height) ?? 0;
  const minLevel = Number(tags['building:min_level']);
  if (!minHeight && Number.isFinite(minLevel) && minLevel > 0) minHeight = minLevel * LEVEL_HEIGHT;
  return {
    height: Math.max(2.4, Math.min(height, 500)),
    minHeight: Math.min(minHeight, height - 1),
  };
}

const ROAD_WIDTH: Record<string, number> = {
  motorway: 14,
  trunk: 12,
  primary: 11,
  secondary: 9.5,
  tertiary: 8.5,
  unclassified: 7,
  residential: 7,
  living_street: 6,
  service: 4.5,
  motorway_link: 6,
  trunk_link: 6,
  primary_link: 6,
  secondary_link: 6,
  tertiary_link: 6,
};

export function roadWidth(tags: Record<string, string>): number | null {
  const kind = tags.highway;
  if (!kind || !(kind in ROAD_WIDTH)) return null; // footways, tracks, steps…
  const width = parseLength(tags.width);
  if (width && width > 2 && width < 40) return width;
  const lanes = Number(tags.lanes);
  if (Number.isFinite(lanes) && lanes > 0) return Math.max(4, lanes * 3.4);
  return ROAD_WIDTH[kind];
}

function areaKind(tags: Record<string, string>): OsmArea['kind'] | null {
  if (tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'pitch')
    return 'park';
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'forest';
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return 'water';
  if (tags.amenity === 'parking' && tags.parking !== 'underground') return 'parking';
  if (/^(grass|meadow|village_green|recreation_ground|cemetery)$/.test(tags.landuse ?? ''))
    return 'grass';
  return null;
}

const toLL = (g: { lat: number; lon: number }): LatLng => ({ lat: g.lat, lng: g.lon });

export function parseOverpass(elements: OverpassElement[]): OsmFeatures {
  const out: OsmFeatures = { buildings: [], roads: [], areas: [], points: [] };
  for (const e of elements) {
    const tags = e.tags ?? {};
    if (e.type === 'node' && e.lat !== undefined && e.lon !== undefined) {
      const at = { lat: e.lat, lng: e.lon };
      const kind =
        tags.natural === 'tree'
          ? 'tree'
          : tags.highway === 'traffic_signals'
            ? 'traffic_signals'
            : tags.highway === 'stop'
              ? 'stop'
              : tags.highway === 'give_way'
                ? 'give_way'
                : null;
      if (kind) out.points.push({ id: e.id, kind, at, direction: tags.direction ?? null });
      continue;
    }
    // Multipolygon buildings and areas: use their outer rings.
    const rings =
      e.type === 'way' && e.geometry
        ? [e.geometry]
        : (e.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry!);
    for (const ring of rings) {
      const pts = ring.map(toLL);
      if (pts.length < 2) continue;
      if (tags.building || tags['building:part']) {
        if (pts.length < 4) continue;
        const { height, minHeight } = buildingHeight(tags);
        out.buildings.push({
          id: e.id,
          outline: pts,
          height,
          minHeight,
          kind: tags.building ?? 'yes',
          roofShape: tags['roof:shape'] ?? null,
          colour: tags['building:colour'] ?? null,
        });
      } else if (tags.highway && e.type === 'way') {
        const width = roadWidth(tags);
        if (width) out.roads.push({ id: e.id, line: pts, kind: tags.highway, width });
      } else if (tags.natural === 'tree_row') {
        // Trees every ~8 m along the row.
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          const n = Math.max(1, Math.round(Math.hypot(b.lat - a.lat, b.lng - a.lng) / 0.00007));
          for (let k = 0; k < n; k++) {
            out.points.push({
              id: e.id * 1000 + i * 50 + k,
              kind: 'tree',
              at: {
                lat: a.lat + ((b.lat - a.lat) * k) / n,
                lng: a.lng + ((b.lng - a.lng) * k) / n,
              },
              direction: null,
            });
          }
        }
      } else {
        const kind = areaKind(tags);
        if (kind && pts.length >= 4) out.areas.push({ id: e.id, kind, outline: pts });
      }
    }
  }
  return out;
}

/** Overpass QL for everything within `radius` metres of a polyline. */
export function cityQuery(line: LatLng[], radius: number): string {
  const around = `around:${radius},${line.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(',')}`;
  return `[out:json][timeout:25];(
way(${around})["building"];
relation(${around})["building"]["type"="multipolygon"];
way(${around})["building:part"];
way(${around})["highway"];
way(${around})["landuse"~"^(grass|meadow|forest|village_green|recreation_ground|cemetery)$"];
way(${around})["leisure"~"^(park|garden|pitch)$"];
way(${around})["natural"~"^(wood|water|tree_row)$"];
way(${around})["amenity"="parking"];
node(${around})["natural"="tree"];
node(${around})["highway"~"^(traffic_signals|stop|give_way)$"];
);out tags geom;`;
}

export async function fetchCity(line: LatLng[], radius: number): Promise<OsmFeatures> {
  const body = await fetchJson<{ elements: OverpassElement[] }>(
    OVERPASS,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: cityQuery(line, radius) }).toString(),
    },
    30_000,
  );
  return parseOverpass(body.elements ?? []);
}
