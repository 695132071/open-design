import { constants } from "node:os";

/**
 * Exit status the supervisor reports for its target.
 *
 * Invariant: the supervisor's own exit must not hide how its target ended.
 * - A stop the supervisor forwarded (SIGINT/SIGTERM from its owner) is an
 *   orderly shutdown and exits 0.
 * - A target killed by any other signal (e.g. an external SIGKILL) exits with
 *   the POSIX shell convention 128 + signal number, so observers that only see
 *   the supervisor can still tell the target was killed.
 * - Otherwise the target's own exit code passes through (unknown → 1).
 */
export function supervisorExitCode(
  code: number | null,
  signal: NodeJS.Signals | null,
  forwardedSignal: NodeJS.Signals | null,
): number {
  if (forwardedSignal != null) return 0;
  if (signal != null) {
    const signalNumber = (constants.signals as Record<string, number | undefined>)[signal];
    return signalNumber != null ? 128 + signalNumber : 1;
  }
  return code ?? 1;
}

/**
 * Inverse of {@link supervisorExitCode} for observers of a supervisor process:
 * recovers the target's terminating signal from a 128 + N exit code.
 */
export function signalFromSupervisorExitCode(code: number | null): NodeJS.Signals | null {
  if (code == null || code <= 128) return null;
  const signalNumber = code - 128;
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === signalNumber) return name as NodeJS.Signals;
  }
  return null;
}
