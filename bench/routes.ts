import type { Waypoint } from "./autopilot"

/**
 * Benchmark flights per map. Each one should cover the views that cost the
 * most: low over grass, close to detailed objects, and high with the whole
 * map in view. Keep them clear of obstacles so the path stays deterministic.
 */
export const ROUTES: Record<string, Waypoint[]> = {
  field: [
    // Low over the grass past the bando
    { position: [0, 2.5, -12], speed: 6 },
    { position: [7, 2.5, -30], speed: 10 },
    { position: [14, 2.5, -48], speed: 10 },
    // Climb out for the overview: whole map, tower and forest in frame
    { position: [0, 14, -72], speed: 12 },
    { position: [-24, 32, -88], speed: 15 },
    { position: [-62, 34, -20], speed: 15 },
    // Dive down the road
    { position: [-24, 6, 18], speed: 15 },
    { position: [-24, 2.5, 40], speed: 12 },
    // Past the pipes and over the container yard
    { position: [8, 3, 42], speed: 12 },
    { position: [30, 8, 10], speed: 12 },
    { position: [44, 9, -10], speed: 8 },
    // Home
    { position: [6, 3, 2], speed: 10 },
    { position: [0, 2, 0], speed: 4 },
  ],
}
