import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type SimulatedResult = "auto" | "success" | "failed";

export interface SimulatedPrintJob {
  type?: "print";
  file: string;
  modelsPerPlate?: number;
  printTimeMinutes: number;
  runs?: number;
  result?: SimulatedResult;
  failAtPercent?: number;
  /**
   * Material of the spool actually loaded in the feeding AMS slot,
   * overriding the material parsed from the file name. Use this to
   * simulate an operator loading the wrong (RFID-tagged) spool.
   */
  loadedFilament?: string;
  /**
   * Color (hex, RRGGBB) of the spool actually loaded in the feeding
   * AMS slot, overriding the color parsed from the file name. Use this to
   * simulate a spool with the right material but the wrong color.
   */
  loadedColor?: string;
  /**
   * Forced failure cause for jobs with result "failed". If omitted, a
   * cause is drawn from a weighted pool of realistic causes.
   */
  cause?: string;
}
}

export interface SimulatedIdleJob {
  type: "idle";
  idleMinutes: number;
}

export type SimulationJob = SimulatedPrintJob | SimulatedIdleJob;

export interface SimulationPrinterPlan {
  jobs: SimulationJob[];
}

export interface SimulationConfig {
  failureProbability?: number;
  loop?: boolean;
  terminalStateSeconds?: number;
  printers?: Record<string, SimulationPrinterPlan>;
}

const DEFAULT_CONFIG: Required<Pick<SimulationConfig, "failureProbability" | "loop" | "terminalStateSeconds">> = {
  failureProbability: 0.15,
  loop: true,
  terminalStateSeconds: 20,
};

export function getSimulationConfigPath(): string {
  return (
    process.env.BAMBU_MCP_SIM_CONFIG ||
    path.join(
      process.env.BAMBU_MCP_CONFIG_DIR || path.join(os.homedir(), ".bambu-mcp"),
      "simulation.json",
    )
  );
}

export function loadSimulationConfig(): SimulationConfig {
  const configPath = getSimulationConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as SimulationConfig;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      printers: parsed.printers || {},
    };
  } catch (err: any) {
    console.error(
      `Simulation config not found or invalid at ${configPath}: ${err?.message || err}. Printers without plans will remain idle.`,
    );
    return { ...DEFAULT_CONFIG, printers: {} };
  }
}

export function isSimulationEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    (process.env.BAMBU_MCP_SIMULATION || "").toLowerCase(),
  );
}
