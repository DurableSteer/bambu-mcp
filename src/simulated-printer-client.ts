import { BambuMQTTClient } from "./mqtt-client.js";
import type { PrinterConfig, PrinterStatus } from "./types.js";
import {
  loadSimulationConfig,
  type SimulationJob,
  type SimulatedPrintJob,
} from "./simulation-config.js";

type Phase = "idle" | "printing" | "terminal" | "done";
type Outcome = "success" | "failed";

interface ExpandedPrintJob extends SimulatedPrintJob {
  type: "print";
}

interface RuntimeState {
  phase: Phase;
  cursor: number;
  phaseStartedAt: number;
  current?: SimulationJob;
  outcome?: Outcome;
  failAtPercent?: number;
}

export class SimulatedPrinterClient extends BambuMQTTClient {
  private readonly printer: PrinterConfig;
  private simulatedConnected = false;
  private readonly plan: SimulationJob[];
  private readonly failureProbability: number;
  private readonly loop: boolean;
  private readonly terminalStateMs: number;
  private state: RuntimeState;

  constructor(printer: PrinterConfig) {
    super({
      host: printer.host,
      port: 8883,
      username: "bblp",
      password: printer.accessCode,
      deviceId: printer.serialNumber,
      model: printer.model,
    });

    this.printer = printer;
    const config = loadSimulationConfig();
    this.failureProbability = Math.min(1, Math.max(0, config.failureProbability ?? 0.15));
    this.loop = config.loop ?? true;
    this.terminalStateMs = Math.max(0, (config.terminalStateSeconds ?? 20) * 1000);
    this.plan = this.expandPlan(config.printers?.[printer.id]?.jobs || []);
    this.state = {
      phase: "idle",
      cursor: 0,
      phaseStartedAt: Date.now(),
    };
  }

  private expandPlan(jobs: SimulationJob[]): SimulationJob[] {
    const expanded: SimulationJob[] = [];
    for (const job of jobs) {
      if (job.type === "idle") {
        expanded.push(job);
        continue;
      }
      const runs = Math.max(1, Math.floor(job.runs ?? 1));
      for (let i = 0; i < runs; i++) {
        expanded.push({ ...job, type: "print", runs: 1 } as ExpandedPrintJob);
      }
    }
    return expanded;
  }

  async connect(): Promise<void> {
    this.simulatedConnected = true;
    this.state = {
      phase: "idle",
      cursor: 0,
      phaseStartedAt: Date.now(),
    };
    this.startCurrentPhase(Date.now());
    console.error(
      `Connected simulated printer ${this.printer.serialNumber} (${this.printer.id}) with ${this.plan.length} planned run(s).`,
    );
  }

  disconnect(): void {
    this.simulatedConnected = false;
  }

  isConnected(): boolean {
    return this.simulatedConnected;
  }

  private startCurrentPhase(now: number): void {
    if (this.plan.length === 0) {
      this.state = { phase: "done", cursor: 0, phaseStartedAt: now };
      return;
    }

    if (this.state.cursor >= this.plan.length) {
      if (!this.loop) {
        this.state = {
          phase: "done",
          cursor: this.plan.length,
          phaseStartedAt: now,
        };
        return;
      }
      this.state.cursor = 0;
    }

    const job = this.plan[this.state.cursor];
    if (job.type === "idle") {
      this.state = {
        phase: "idle",
        cursor: this.state.cursor,
        phaseStartedAt: now,
        current: job,
      };
      return;
    }

    const requestedResult = job.result ?? "auto";
    const outcome: Outcome =
      requestedResult === "failed"
        ? "failed"
        : requestedResult === "success"
          ? "success"
          : Math.random() < this.failureProbability
            ? "failed"
            : "success";

    const failAtPercent =
      outcome === "failed"
        ? Math.min(
            95,
            Math.max(
              5,
              job.failAtPercent ?? Math.round(15 + Math.random() * 70),
            ),
          )
        : undefined;

    this.state = {
      phase: "printing",
      cursor: this.state.cursor,
      phaseStartedAt: now,
      current: job,
      outcome,
      failAtPercent,
    };
  }

  private advance(now: number): void {
    // A bounded loop lets a long gap between MCP calls skip over several jobs safely.
    for (let guard = 0; guard < Math.max(4, this.plan.length * 3 + 4); guard++) {
      const current = this.state.current;

      if (this.state.phase === "done") return;

      if (this.state.phase === "idle") {
        if (!current || current.type !== "idle") return;
        const durationMs = Math.max(0, current.idleMinutes * 60_000);
        if (now - this.state.phaseStartedAt < durationMs) return;
        this.state.cursor += 1;
        this.startCurrentPhase(this.state.phaseStartedAt + durationMs);
        continue;
      }

      if (this.state.phase === "printing") {
        if (!current || current.type === "idle") return;
        const fullDurationMs = Math.max(1_000, current.printTimeMinutes * 60_000);
        const finishFraction =
          this.state.outcome === "failed"
            ? (this.state.failAtPercent ?? 50) / 100
            : 1;
        const activeDurationMs = fullDurationMs * finishFraction;
        if (now - this.state.phaseStartedAt < activeDurationMs) return;
        this.state = {
          ...this.state,
          phase: "terminal",
          phaseStartedAt: this.state.phaseStartedAt + activeDurationMs,
        };
        continue;
      }

      if (this.state.phase === "terminal") {
        if (now - this.state.phaseStartedAt < this.terminalStateMs) return;
        this.state.cursor += 1;
        this.startCurrentPhase(this.state.phaseStartedAt + this.terminalStateMs);
        continue;
      }
    }
  }

  private baseStatus(now: number): PrinterStatus {
    return {
      print_type: "local",
      nozzle_temper: 35,
      nozzle_target_temper: 0,
      bed_temper: 30,
      bed_target_temper: 0,
      chamber_temper: 30,
      big_fan1_speed: "0",
      big_fan2_speed: "0",
      cooling_fan_speed: "0",
      heatbreak_fan_speed: "0",
      spd_lvl: 2,
      spd_mag: 100,
      wifi_signal: "-48dBm",
      lights_report: [{ node: "chamber_light", mode: "on" }],
      print_error: 0,
      hw_switch_state: 0,
      ams: this.buildAms(now),
      ipcam: {
        ipcam_record: "disable",
        timelapse: "disable",
        resolution: "1080p",
      },
    };
  }

  private hashString(input: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /**
   * Deterministic ambient relative humidity (%RH) at wall-clock time `now`,
   * derived only from the printer ID and the timestamp. Like print progress,
   * the curve advances in real time with Date.now() and needs no timer.
   *
   * Shape of a ventilated room:
   * - diurnal cycle peaking around 06:00, bottoming out mid-afternoon,
   * - a slow multi-day "weather" drift (3-7 days, unique per printer),
   * - small faster fluctuations (~2h period) for door/ventilation bursts,
   * - clamped to a plausible indoor range of 20-70%.
   */
  private moisturePercent(now: number): number {
    const seed = this.hashString(this.printer.id);
    const unit = (salt: number): number =>
      ((Math.imul(seed ^ Math.imul(salt, 0x9e3779b1), 0x85ebca6b) >>> 13) % 10_000) / 10_000;

    const d = new Date(now);
    const hourFrac = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const diurnal = Math.cos((2 * Math.PI * (hourFrac - 6)) / 24);

    const driftPeriodMs = (3 + unit(2) * 4) * 86_400_000;
    const drift = Math.sin((2 * Math.PI * now) / driftPeriodMs + unit(3) * 2 * Math.PI);

    const flutter = Math.sin((2 * Math.PI * now) / (2 * 3_600_000) + unit(4) * 2 * Math.PI);

    const value = 45 + 6 * diurnal + 4 * drift + 1.5 * flutter;
    return Math.min(70, Math.max(20, value));
  }

  private amsTempC(now: number): number {
    const d = new Date(now);
    const hourFrac = d.getHours() + d.getMinutes() / 60;
    return 24 + 2.5 * Math.cos((2 * Math.PI * (hourFrac - 15)) / 24);
  }

  private colorHex(colorName: string): string {
    switch (colorName.trim().toLowerCase()) {
      case "schwarz":
        return "000000";
      case "weiß":
      case "weiss":
        return "FFFFFF";
      case "natur":
        return "F0E7D8";
      default:
        return "CCCCCC";
    }
  }

  /**
   * Builds the ams.ams[] block, mirroring the real MQTT report structure from
   * types.ts. Trays represent the physically loaded spools (RFID-identified).
   *
   * While a job is active, the slot feeding the print is derived
   * deterministically from the file name and normally holds a spool matching
   * the planned material parsed from the file name. A job may optionally
   * specify `loadedFilament` in simulation.json to simulate an operator
   * loading the wrong spool — the planned-vs-loaded comparison in the
   * dashboard will then flag a mismatch.
   */
  private buildAms(now: number): PrinterStatus["ams"] {
    const trays = [
      { id: "0", tray_type: "PLA", tray_color: "FFFFFF", remain: 88 },
      { id: "1", tray_type: "PETG", tray_color: "000000", remain: 42 },
      { id: "2", tray_type: "ABS", tray_color: "000000", remain: 71 },
      { id: "3", tray_type: "PA12", tray_color: "F0E7D8", remain: 15 },
    ];

    const current = this.state.current;
    if (current && current.type !== "idle" && typeof current.file === "string") {
      const match = /\(([^,()]+),\s*([^()]+)\)/.exec(current.file);
      if (match) {
        const plannedMaterial = match[1].trim();
        const plannedColorHex = this.colorHex(match[2]);

        // Optional per-job override; not declared in simulation-config.ts,
        // hence the intersection cast. If you add
        // `loadedFilament?: string;` to the print-job interface in
        // simulation-config.ts, the cast can be dropped.
        const job = current as SimulationJob & { loadedFilament?: string };
        const loadedFilament = job.loadedFilament?.trim() || null;

        // Feeding slot stays constant for the whole job.
        const slot = this.hashString(current.file) % trays.length;

        trays[slot] = {
          id: String(slot),
          tray_type: loadedFilament ?? plannedMaterial,
          tray_color: plannedColorHex,
          remain: trays[slot].remain,
        };

        return {
          ams: [
            {
              id: "0",
              humidity: String(Math.round(this.moisturePercent(now))),
              temp: this.amsTempC(now).toFixed(1),
              tray: trays,
            },
          ],
          ams_exist_bits: "1",
          tray_now: String(slot),
        };
      }
    }

    return {
      ams: [
        {
          id: "0",
          humidity: String(Math.round(this.moisturePercent(now))),
          temp: this.amsTempC(now).toFixed(1),
          tray: trays,
        },
      ],
      ams_exist_bits: "1",
      tray_now: "0",
    };
  }
  async requestStatus(): Promise<PrinterStatus> {
    return this.getCachedStatus();
  }

  /**
   * Overrides the upstream cache lookup: in simulation there is no MQTT
   * stream filling `lastStatus`, so the status is generated from the
   * wall-clock-driven job state instead.
   */
  override getCachedStatus(): PrinterStatus {
    const now = Date.now();
    this.advance(now);

    const current = this.state.current;
    const status: PrinterStatus = this.baseStatus(now);

    if (this.state.phase === "terminal") {
      const failed = this.state.outcome === "failed";
      const total = this.totalLayers(current);
      return {
        ...status,
        gcode_state: failed ? "FAILED" : "FINISH",
        subtask_name:
          current && current.type !== "idle" ? current.file : undefined,
        mc_percent: failed ? (this.state.failAtPercent ?? 50) : 100,
        mc_remaining_time: 0,
        layer_num: failed
          ? Math.round(((this.state.failAtPercent ?? 50) / 100) * total)
          : total,
        total_layer_num: total,
        stg_cur: -1,
        _cached_at: new Date(now).toISOString(),
        _age_seconds: 0,
      };
    }

    if (this.state.phase !== "printing" || !current || current.type === "idle") {
      return {
        ...status,
        gcode_state: "IDLE",
        stg_cur: -1,
        _cached_at: new Date(now).toISOString(),
        _age_seconds: 0,
      };
    }

    const fullDurationMs = Math.max(1_000, current.printTimeMinutes * 60_000);
    const finishFraction =
      this.state.outcome === "failed"
        ? (this.state.failAtPercent ?? 50) / 100
        : 1;
    const activeDurationMs = fullDurationMs * finishFraction;
    const elapsedMs = Math.min(now - this.state.phaseStartedAt, activeDurationMs);
    const percent = Math.floor((elapsedMs / fullDurationMs) * 100);
    const total = this.totalLayers(current);

    return {
      ...status,
      gcode_state: "RUNNING",
      subtask_name: current.file,
      mc_percent: percent,
      mc_remaining_time: Math.ceil((fullDurationMs - elapsedMs) / 60_000),
      layer_num: Math.max(1, Math.round((percent / 100) * total)),
      total_layer_num: total,
      stg_cur: 0,
      nozzle_temper: 220,
      nozzle_target_temper: 220,
      bed_temper: 60,
      bed_target_temper: 60,
      chamber_temper: 35,
      big_fan1_speed: "15",
      cooling_fan_speed: "80",
      _cached_at: new Date(now).toISOString(),
      _age_seconds: 0,
    };
  }

  /** Stable pseudo-random layer count per job file, so layer numbers
   * don't jump between polls. */
  private totalLayers(job: SimulationJob | undefined): number {
    if (!job || job.type === "idle" || typeof job.file !== "string") return 0;
    return 40 + (this.hashString(job.file) % 160);
  }

  async getVersion(): Promise<any> {
    return {
      command: "get_version",
      sequence_id: "0",
      module: [
        {
          name: "ota",
          sw_ver: "01.08.00.00",
          hw_ver: this.printer.model || "P1S",
          sn: this.printer.serialNumber,
        },
      ],
      result: "success",
    };
  }

  private readonlyFailure(command: string): any {
    return {
      command,
      result: "fail",
      reason: "simulation_read_only",
    };
  }

  async stopPrint(): Promise<any> {
    return this.readonlyFailure("stop");
  }

  async pausePrint(): Promise<any> {
    return this.readonlyFailure("pause");
  }

  async resumePrint(): Promise<any> {
    return this.readonlyFailure("resume");
  }

  async setPrintSpeed(_speed: number): Promise<any> {
    return this.readonlyFailure("print_speed");
  }

  async sendGcode(_gcode: string): Promise<any> {
    return this.readonlyFailure("gcode_line");
  }

  async printFile(_options: any): Promise<any> {
    return this.readonlyFailure("project_file");
  }

  async changeFilament(_tray: number, _targetTemp?: number): Promise<any> {
    return this.readonlyFailure("ams_change_filament");
  }

  async unloadFilament(): Promise<any> {
    return this.readonlyFailure("unload_filament");
  }

  async setLED(_mode: "on" | "off", _node: string = "chamber_light"): Promise<any> {
    return this.readonlyFailure("ledctrl");
  }

  async setCameraRecording(_enabled: boolean): Promise<any> {
    return this.readonlyFailure("ipcam_record_set");
  }

  async setTimelapse(_enabled: boolean): Promise<any> {
    return this.readonlyFailure("ipcam_timelapse");
  }

  async setNozzle(_diameter: number): Promise<any> {
    return this.readonlyFailure("set_accessories");
  }

  async skipObjects(_objectIds: number[]): Promise<any> {
    return this.readonlyFailure("skip_objects");
  }
}
