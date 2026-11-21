# PVMBG mapping (D-36)

`mapping.json` is read by every Aggregator replica (`PVMBG_MAPPING_PATH`) and re-read when its content hash changes
(`PVMBG_MAPPING_POLL_MS`). An invalid file is rejected and the previous mapping stays active.
Policy and field meanings: `docs/orang-c/SCHEMA_POLICY.md`. Example adjustment for the P3 demo: `examples/m2-adjusted.json`.
