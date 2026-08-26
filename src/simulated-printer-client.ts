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
  private connected = false;
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
    this.connected = true;
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
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
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

  private baseStatus(): PrinterStatus {
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
      ipcam: {
        ipcam_record: "disable",
        timelapse: "disable",
        resolution: "1080p",
      },
    };
  }

  getCachedStatus(): PrinterStatus {
    const now = Date.now();
    this.advance(now);

    const status: PrinterStatus = this.baseStatus();
    const current = this.state.current;

    if (this.state.phase === "printing" && current && current.type !== "idle") {
      const fullDurationMs = Math.max(1_000, current.printTimeMinutes * 60_000);
      const elapsedMs = Math.max(0, now - this.state.phaseStartedAt);
      const percent = Math.min(99, Math.max(0, Math.floor((elapsedMs / fullDurationMs) * 100)));
      const totalLayers = Math.max(20, Math.round(current.printTimeMinutes * 3));

      Object.assign(status, {
        gcode_state: "RUNNING",
        stg_cur: 0,
        mc_percent: percent,
        mc_remaining_time: Math.max(1, Math.ceil((fullDurationMs - elapsedMs) / 60_000)),
        layer_num: Math.max(1, Math.floor((percent / 100) * totalLayers)),
        total_layer_num: totalLayers,
        subtask_name: current.file,
        nozzle_temper: 220,
        nozzle_target_temper: 220,
        bed_temper: 60,
        bed_target_temper: 60,
        chamber_temper: 38,
        cooling_fan_speed: "12",
        heatbreak_fan_speed: "10",
      });
    } else if (this.state.phase === "terminal" && current && current.type !== "idle") {
      const failed = this.state.outcome === "failed";
      const terminalPercent = failed ? this.state.failAtPercent ?? 50 : 100;
      const totalLayers = Math.max(20, Math.round(current.printTimeMinutes * 3));

      Object.assign(status, {
        gcode_state: failed ? "FAILED" : "FINISH",
        stg_cur: -1,
        mc_percent: terminalPercent,
        mc_remaining_time: 0,
        layer_num: Math.max(1, Math.floor((terminalPercent / 100) * totalLayers)),
        total_layer_num: totalLayers,
        subtask_name: current.file,
        print_error: failed ? 1 : 0,
      });
    } else {
      Object.assign(status, {
        gcode_state: "IDLE",
        stg_cur: -1,
        mc_percent: 0,
        mc_remaining_time: 0,
        layer_num: 0,
        total_layer_num: 0,
      });
    }

    return {
      ...status,
      _cached_at: new Date(now).toISOString(),
      _age_seconds: 0,
    };
  }

  async requestStatus(): Promise<PrinterStatus> {
    return this.getCachedStatus();
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
