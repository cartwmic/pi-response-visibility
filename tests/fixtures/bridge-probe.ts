import { appendFileSync } from "node:fs";
export default function () {
  const out = process.env.RV_PROBE_OUT!;
  const bridge = (globalThis as any)[Symbol.for("pi.response-visibility.telemetry.v1")];
  appendFileSync(out, JSON.stringify({ bridge: Boolean(bridge) }) + "\n");
  bridge?.subscribe((e: any) => appendFileSync(out, JSON.stringify({ kind: e.kind, origin: e.origin, phase: e.data?.phase, stage: e.data?.stage, transport: e.data?.transport }) + "\n"));
}
