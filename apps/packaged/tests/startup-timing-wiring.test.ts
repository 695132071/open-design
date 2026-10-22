import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
function select(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (predicate(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!found) throw new Error("startup wiring not found");
  return found;
}
function evaluate(code: string, globals: Record<string, unknown>) {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, globals);
}

describe("packaged launch timing wiring", () => {
  it("retains daemon/web phase edges and leaves launch delivery to the daemon-backed desktop reporter (OPEND-4220)", () => {
    const method = select(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === "onPhase");
    const mark = vi.fn();
    const setReporter = vi.fn();
    const reportPackagedLaunch = vi.fn();
    const onPhase = evaluate(`const options = { ${method.getText(ast)} }; options.onPhase;`, {
      packagedStartupTiming: { mark, setReporter }, reportPackagedLaunch, setSplashStage: vi.fn(), splash: null,
    }) as (phase: string) => void;
    for (const phase of ["daemon-spawning", "daemon-ready", "web-spawning", "web-ready"]) onPhase(phase);
    expect(mark.mock.calls.flat()).toEqual(["daemon_spawning", "daemon_ready", "web_spawning", "web_ready"]);
    // The direct packaged reporter would send client_launch_attempt before a
    // fresh install has an installation identity, silently dropping it.
    expect(setReporter).not.toHaveBeenCalled();
  });

  it("correlates an early failure and waits for bounded telemetry before the existing fatal exit", async () => {
    const call = select(node => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "catch" && node.expression.expression.getText(ast) === "main()") as ts.CallExpression;
    const handler = call.arguments[0]!;
    const flush = Promise.withResolvers<void>();
    const timing = { context: () => ({ app_session_id: "session-1", launch_attempt_id: "launch-1" }), setReporter: vi.fn(), finish: vi.fn(), flush: vi.fn(() => flush.promise) };
    const exit = vi.fn();
    const reportFailure = vi.fn(async () => undefined);
    const run = evaluate(`const handler = ${handler.getText(ast)}; handler;`, {
      packagedStartupTiming: timing, reportPackagedLaunch: vi.fn(),
      PackagedPathAccessError: class extends Error {},
      classifyStartupFailure: () => ({ failureKind: "daemon-start" }),
      packagedLogger: null, console: { error: vi.fn() },
      startupTelemetryContext: { namespace: "test", installationRoot: "test" },
      reportStartupFailure: reportFailure, resolveStartupDistinctId: () => "installation-1",
      process: { exit }, resolveSidecarLauncherExitCode: () => 1,
    }) as (error: Error) => Promise<void>;
    const pending = run(new Error("daemon failed"));
    expect(timing.finish).toHaveBeenCalledExactlyOnceWith("failed", "daemon-start");
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    flush.resolve();
    await pending;
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});


it("does not create a process launch for deferred restores, including a failed restore retry", async () => {
  const launch = select(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === "launch") as ts.PropertyAssignment;
  const timing = select(node => ts.isPropertyAssignment(node) && node.name.getText(ast) === "startupTiming") as ts.PropertyAssignment;
  const create = vi.fn();
  const launchDesktop = vi.fn().mockRejectedValueOnce(new Error("restore failed")).mockResolvedValueOnce("restored");
  const globals = {
    deferredHeadless: true, packagedStartupTiming: null, activeConfig: { appVersion: "1.0.0" },
    createDesktopStartupTiming: create, reportPackagedLaunch: vi.fn(),
    createSplashWindow: vi.fn(), splash: null, launchDesktop,
  };
  expect(evaluate(timing.initializer.getText(ast), globals)).toBeNull();
  const restore = evaluate(`(${launch.initializer.getText(ast)})`, globals) as () => Promise<unknown>;
  await expect(restore()).rejects.toThrow("restore failed");
  await expect(restore()).resolves.toBe("restored");
  expect(create).not.toHaveBeenCalled();
});

it('passes the original Electron ready timestamp through the packaged desktop boundary', () => {
  const ready = select(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'electronReadyAtMs') as ts.VariableDeclaration;
  const option = select(node => ts.isShorthandPropertyAssignment(node) && node.name.text === 'electronReadyAtMs');
  const readyAt = evaluate(ready.initializer!.getText(ast), { performance: { now: () => 10_000 } });
  const passed = evaluate(`({ ${option.getText(ast)} })`, { electronReadyAtMs: readyAt });
  expect(passed).toEqual({ electronReadyAtMs: 10_000 });
  const readyIndex = source.indexOf('await app.whenReady()');
  const clockIndex = source.indexOf('const electronReadyAtMs');
  const sidecarsIndex = source.indexOf('await startPackagedSidecars');
  expect(readyIndex).toBeLessThan(clockIndex);
  expect(clockIndex).toBeLessThan(sidecarsIndex);
});
