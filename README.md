# bambu-mcp simulator overlay

This is a minimal simulation fork layer for `griches/bambu-mcp`.

It intentionally preserves the upstream MCP tool registration, tool names, schemas, `FleetManager` shape, `conn.mqtt` property, and normal `get_status` formatting. The only transport change is that when `BAMBU_MCP_SIMULATION=1`, `FleetManager` instantiates `SimulatedPrinterClient`, a subclass of the upstream `BambuMQTTClient`, instead of opening a real MQTT connection.

The Docker build pins upstream commit:

`ca6db60364afc9b399045aa754197cd3dae842ea`

## Run

```bash
docker compose up --build
```

The MCP HTTP proxy is exposed on port 8080, matching the supplied upstream container pattern.

## Config

`config/printers.json` deliberately uses the original upstream printer configuration schema. This means `list_printers`, startup loading, printer IDs, names, model names, serials, and management-tool schemas remain unchanged.

`config/simulation.json` adds simulation-only production plans, keyed by the original printer ID.

A print job supports:

- `file`: filename reported in `subtask_name`
- `modelsPerPlate`: production-plan metadata only; deliberately not injected into MCP status because a real Bambu status does not expose this field
- `printTimeMinutes`: wall-clock print duration
- `runs`: repeated plates of the same job
- `result`: `auto`, `success`, or `failed`
- `failAtPercent`: optional deterministic failure point when `result` is `failed`

An idle job uses:

```json
{ "type": "idle", "idleMinutes": 2 }
```

Global options:

- `failureProbability`: default 0.15
- `loop`: restart each printer's plan after the last job
- `terminalStateSeconds`: how long FINISH/FAILED remains observable before the next job starts

## Status behavior

The simulator generates Bambu-like fields through the existing `get_status` tool:

- `gcode_state`: `IDLE`, `RUNNING`, `FINISH`, `FAILED`
- `mc_percent`
- `mc_remaining_time` in minutes, matching upstream formatting
- `subtask_name`
- `layer_num` / `total_layer_num`
- `stg_cur`
- temperatures, fans, speed, Wi-Fi, light state, camera fields, and `print_error`
- `_cached_at` and `_age_seconds`

Progress is calculated from `Date.now()`, so printers advance in real wall-clock time without a polling timer.

For `result: "auto"`, the success/failure decision is made when a job begins. By default each print has a 15% chance to fail. Failed jobs stop at a random point between roughly 15% and 85% unless `failAtPercent` is supplied.

## Existing control tools

All upstream MCP tools remain registered and keep their original schemas. MQTT control methods on simulated printers return a read-only failure response rather than mutating the production plan or sending a command anywhere.

FTP-backed tools are intentionally untouched in this first overlay. With the supplied fake `127.0.0.1` hosts they will fail rather than talk to a real printer. If a demo needs convincing `list_files`, upload/download, or camera/file behavior, the next layer should mock the FTP client while still leaving those MCP schemas unchanged.
