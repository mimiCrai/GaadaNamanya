# Fire Processor

Turns `satellite.raw` hotspot records into `WILDFIRE` HazardEvents (P4), built from `express-template`.

## Structure

```
src/
├── app.ts, server.ts          # Express + Inversify bootstrap (health endpoints)
├── constants/fire.ts          # Fire definition: 1 km / 360 min links, grid, severity levels
├── data/provinces.json        # Province centroids (scripts/satellite/build-provinces.mjs)
├── libs/
│   ├── decimal.ts             # Exact decimal math for FRP sums and centroids
│   ├── raw-json.ts            # JSON member scanner that keeps raw number text
│   ├── feed-parser.ts         # satellite.raw record -> FeedEvent
│   ├── geo.ts                 # Haversine, link rule, spatial grid
│   ├── fire-graph.ts          # Connected components of active detections
│   ├── fire-registry.ts       # Stable fire IDs, merge/split/dissolve
│   ├── hazard-mapper.ts       # Fire -> HazardEvent (severity, centroid, province)
│   └── province-index.ts      # Nearest province lookup
├── services/fire-engine.service.ts  # Watermark/lateness, update/retract, snapshot/restore
├── types/fire.ts
└── util/                      # env, compareText, isoSeconds
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start with watch |
| `npm run build` | Compile TypeScript |
| `npm test` | Run unit tests |
| `npm run lint` | Run ESLint |
