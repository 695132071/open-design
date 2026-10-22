import { constants } from "node:os";
import { describe, expect, it } from "vitest";

import { signalFromSupervisorExitCode, supervisorExitCode } from "../src/supervisor-exit.js";

describe("supervisorExitCode", () => {
  it("reports a target killed by an external SIGKILL as 128 + N, not a clean exit", () => {
    expect(supervisorExitCode(null, "SIGKILL", null)).toBe(128 + constants.signals.SIGKILL);
    expect(supervisorExitCode(null, "SIGKILL", null)).not.toBe(0);
  });

  it("keeps an orderly stop it forwarded as a clean exit", () => {
    expect(supervisorExitCode(null, "SIGTERM", "SIGTERM")).toBe(0);
    expect(supervisorExitCode(0, null, "SIGINT")).toBe(0);
  });

  it("passes through the target's own exit code", () => {
    expect(supervisorExitCode(0, null, null)).toBe(0);
    expect(supervisorExitCode(7, null, null)).toBe(7);
    expect(supervisorExitCode(null, null, null)).toBe(1);
  });

  it("round-trips the signal for observers", () => {
    for (const signal of ["SIGKILL", "SIGTERM", "SIGSEGV", "SIGABRT"] as const) {
      expect(signalFromSupervisorExitCode(supervisorExitCode(null, signal, null))).toBe(signal);
    }
    expect(signalFromSupervisorExitCode(0)).toBeNull();
    expect(signalFromSupervisorExitCode(7)).toBeNull();
    expect(signalFromSupervisorExitCode(null)).toBeNull();
  });
});
