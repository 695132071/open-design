import { expect, test } from '@/playwright/suite';
import type { Page } from '@playwright/test';

import {
  AMR_PERSONAL_WORKSPACE_CONTEXT,
  gotoEntryHome,
  mockAmrPersonalWorkspace,
  seedBrowserConfig,
} from '@/playwright/amr';
import {
  applyStandardMocks,
  routeAgents,
  routeSuccessfulRuns,
  suppressWhatsNew,
} from '@/playwright/mock-factory';
import { mockSignedInVelaAccount } from '@/playwright/visual';
import { T } from '@/timeouts';

/*
 * Home opens the project frame on the click tick. Workspace billing is display
 * data, so project creation and run admission must not wait for its response.
 * A fresh cached backend funding rejection holds Home for confirmation; a
 * bare wallet amount cannot do so. Link owns final admission.
 */

declare global {
  interface Window {
    __odHandoffProbe?: {
      frame: number;
      clickFrame: number | null;
      pendingFrame: number | null;
    };
  }
}

const AMR_AGENT = {
  id: 'amr',
  name: 'OpenDesign AMR',
  bin: 'vela',
  available: true,
  version: 'test',
  models: [{ id: 'glm-5', label: 'glm-5' }],
};

const AMR_CONFIG = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  agentId: 'amr',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  agentModels: {},
  privacyDecisionAt: 1,
  telemetry: { metrics: false, content: false, artifactManifest: false },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Frame-accurate probe installed before the app boots: a rAF counter, the
 * frame the send button was clicked on, and the frame the pending frame's
 * root landed in the DOM. "≤ 1 frame" is then a plain subtraction.
 */
async function installHandoffProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { frame: 0, clickFrame: null as number | null, pendingFrame: null as number | null };
    window.__odHandoffProbe = probe;
    const tick = () => {
      probe.frame += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener(
      'click',
      (event) => {
        const target = event.target as Element | null;
        if (probe.clickFrame == null && target?.closest?.('[data-testid="home-hero-submit"]')) {
          probe.clickFrame = probe.frame;
        }
      },
      true,
    );
    new MutationObserver(() => {
      if (
        probe.pendingFrame == null
        && document.querySelector('[data-testid="project-creation-pending-view"]')
      ) {
        probe.pendingFrame = probe.frame;
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

async function readHandoffFrames(page: Page): Promise<number> {
  const probe = await page.evaluate(() => window.__odHandoffProbe ?? null);
  expect(probe?.clickFrame, 'send click was observed').not.toBeNull();
  expect(probe?.pendingFrame, 'pending frame was observed').not.toBeNull();
  return (probe!.pendingFrame as number) - (probe!.clickFrame as number);
}

/** Hold POST /api/projects until released; the create must not gate the frame. */
async function holdProjectCreate(page: Page) {
  const release = deferred();
  let requested = false;
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    requested = true;
    await release.promise;
    await route.continue();
  });
  return { release: release.resolve, requested: () => requested };
}

/** Hold any attempted authoritative billing read to expose send serialization. */
async function holdAmrBillingGate(page: Page) {
  const release = deferred();
  let held = false;
  await page.route('**/api/workspace/billing**', async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() === 'GET'
      && url.pathname === '/api/workspace/billing'
      && url.searchParams.get('freshness') === 'authoritative'
    ) {
      held = true;
      await release.promise;
    }
    await route.fallback();
  });
  return { release: release.resolve, held: () => held };
}

async function wireSignedInAmrHome(
  page: Page,
  options: { accountBalanceUsd?: string } = {},
): Promise<void> {
  await seedBrowserConfig(page, AMR_CONFIG);
  await page.route('**/api/app-config', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    await route.fulfill({ json: { config: AMR_CONFIG } });
  });
  await routeAgents(page, [AMR_AGENT]);
  await mockSignedInVelaAccount(page, { balanceUsd: options.accountBalanceUsd ?? '20.00' });
  await mockAmrPersonalWorkspace(page, undefined, {
    accountBalanceUsd: options.accountBalanceUsd ?? '20.00',
    accountCredits: 2_000,
    accountPlan: 'free',
  });
}

async function sendFromHome(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId('home-hero-input');
  await expect(input).toBeVisible({ timeout: T.medium });
  await input.fill(prompt);
  const submit = page.getByTestId('home-hero-submit');
  await expect(submit).toBeEnabled();
  await submit.click();
}

test.describe.configure({ timeout: T.xlong });

test.beforeEach(async ({ page }) => {
  await suppressWhatsNew(page);
  await installHandoffProbe(page);
});

test('[P0] AMR Home send creates the project without waiting for workspace billing', async ({ page }) => {
  await wireSignedInAmrHome(page);
  const billing = await holdAmrBillingGate(page);
  const create = await holdProjectCreate(page);
  const runBodies: Array<Record<string, unknown>> = [];
  const runRequests = await routeSuccessfulRuns(page, {
    bodies: runBodies,
    runId: 'home-amr-pending-run',
  });

  await gotoEntryHome(page);
  await sendFromHome(page, 'Draft a landing page for a coffee subscription.');

  const pending = page.getByTestId('project-creation-pending-view');
  // The project frame is immediate; its create request can proceed even if
  // an authoritative billing read would never answer.
  await expect(pending).toBeVisible({ timeout: T.short });
  await expect.poll(() => create.requested(), { timeout: T.medium }).toBe(true);
  await expect(page.getByTestId('project-creation-pending-chat')).toBeVisible();
  expect(await readHandoffFrames(page)).toBeLessThanOrEqual(1);

  // Releasing project creation starts the run without releasing billing.
  await expect(pending).toBeVisible();
  create.release();
  await runRequests.expectCount(1);
  expect(runBodies[0]).toMatchObject({ agentId: 'amr' });
  expect(billing.held()).toBe(false);
  billing.release();
  await expect(pending).toBeHidden({ timeout: T.medium });
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.medium });
});

test('[P0] an empty wallet the shell already shows does not block Home: no dialog, frame opens, create proceeds', async ({ page }) => {
  await wireSignedInAmrHome(page, { accountBalanceUsd: '0.00' });
  const create = await holdProjectCreate(page);
  const runRequests = await routeSuccessfulRuns(page, { runId: 'home-amr-empty-wallet-run' });
  const prompt = 'Design a pricing page for an empty wallet.';

  await gotoEntryHome(page);
  await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.medium });
  await sendFromHome(page, prompt);

  const pending = page.getByTestId('project-creation-pending-view');
  await expect(pending).toBeVisible({ timeout: T.medium });
  await expect(page.getByTestId('amr-balance-dialog')).toHaveCount(0);
  await expect.poll(() => create.requested(), { timeout: T.medium }).toBe(true);
  create.release();
  await runRequests.expectCount(1);
});

test('[P0] a stale $0 projection does not force a recharge confirmation before sending', async ({ page }) => {
  await wireSignedInAmrHome(page, { accountBalanceUsd: '0.00' });
  // The shell's display can lag a recharge. Its old zero is never admission
  // evidence, whether or not an authoritative read is available.
  await page.route('**/api/workspace/billing**', async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() !== 'GET'
      || url.pathname !== '/api/workspace/billing'
      || url.searchParams.get('freshness') !== 'authoritative'
    ) {
      await route.fallback();
      return;
    }
    const workspaceId = url.searchParams.get('workspaceId') ?? '';
    const observedAt = '2026-09-17T00:00:00.000Z';
    const workspaceMemberId = AMR_PERSONAL_WORKSPACE_CONTEXT.workspaceMemberId;
    await route.fulfill({
      json: {
        summary: null,
        workspaceBalance: {
          workspaceId,
          workspaceMemberId,
          balanceUsd: '20.00',
          billingScopeVersion: 2,
          expiresAt: null,
          updatedAt: observedAt,
        },
        workspaceRuntime: {
          workspaceId,
          workspaceMemberId,
          status: 'fresh',
          revision: '2',
          observedAt,
          softExpiresAt: '2099-07-26T00:00:30.000Z',
          hardExpiresAt: '2099-07-26T00:02:00.000Z',
          retryAt: null,
          errorCode: null,
          reason: 'authoritative-action-read',
          sourceGapDetected: false,
        },
        authoritativeWorkspaceRead: { workspaceId, workspaceMemberId, observedAt },
      },
    });
  });
  const create = await holdProjectCreate(page);
  const runRequests = await routeSuccessfulRuns(page, { runId: 'home-amr-stale-zero-run' });

  await gotoEntryHome(page);
  await expect(page.getByTestId('home-hero-input')).toBeVisible({ timeout: T.medium });
  await sendFromHome(page, 'Draft a landing page after a recharge.');

  const pending = page.getByTestId('project-creation-pending-view');
  // A stale zero cannot open a funding dialog or prevent project creation.
  await expect(pending).toBeVisible({ timeout: T.medium });
  await expect(page.getByTestId('amr-balance-dialog')).toHaveCount(0);
  await expect.poll(() => create.requested(), { timeout: T.medium }).toBe(true);
  create.release();
  await runRequests.expectCount(1);
});

test('[P1] local-agent send from Home still enters the pending frame within a frame', async ({ page }) => {
  await applyStandardMocks(page);
  const create = await holdProjectCreate(page);
  const runRequests = await routeSuccessfulRuns(page, { runId: 'home-local-pending-run' });

  await gotoEntryHome(page);
  await sendFromHome(page, 'Draft a landing page with the local agent.');

  const pending = page.getByTestId('project-creation-pending-view');
  await expect(pending).toBeVisible({ timeout: T.short });
  expect(await readHandoffFrames(page)).toBeLessThanOrEqual(1);
  create.release();
  await runRequests.expectCount(1);
  await expect(pending).toBeHidden({ timeout: T.medium });
});

test('[P0] cached backend insufficiency stays on Home and dismiss preserves the draft', async ({ page }, testInfo) => {
  await wireSignedInAmrHome(page, { accountBalanceUsd: '0.00' });
  const create = await holdProjectCreate(page);
  const confirmation = deferred();
  let hintReads = 0;
  let sending = false;
  const warmed = page.waitForResponse((response) => response.url().includes('/api/workspace/billing/preflight?') && new URL(response.url()).searchParams.get('modelId') === 'glm-5' && response.ok());
  await page.route('**/api/workspace/billing/preflight?**', async (route) => {
    hintReads++;
    const confirming = sending;
    if (confirming) await confirmation.promise;
    const url = new URL(route.request().url());
    await route.fulfill({ json: { preflight: {
      schemaVersion: 1, workspaceId: url.searchParams.get('workspaceId'),
      workspaceMemberId: AMR_PERSONAL_WORKSPACE_CONTEXT.workspaceMemberId,
      modelId: url.searchParams.get('modelId'), generatedAt: new Date().toISOString(), balanceUsd: '0',
      fundingCheck: confirming ? 'available' : 'insufficient',
    } } });
  });
  try {
    await gotoEntryHome(page);
    await warmed;
    const prompt = 'Keep this unfunded draft on the homepage.';
    const warmReads = hintReads;
    sending = true;
    await sendFromHome(page, prompt);
    const dialog = page.getByTestId('amr-balance-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('home-hero-input')).toBeVisible();
    await expect(page.getByTestId('project-creation-pending-view')).toHaveCount(0);
    expect(create.requested()).toBe(false);
    await expect.poll(() => hintReads).toBe(warmReads + 1);
    await testInfo.attach('home-cached-funding-block', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
    await dialog.getByRole('button', { name: /not now|later|暂不|稍后/i }).click();
    const confirmed = page.waitForResponse((response) => response.url().includes('/api/workspace/billing/preflight?'));
    confirmation.resolve();
    await confirmed;
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('home-hero-input')).toHaveText(prompt);
    await expect(page.getByTestId('home-hero-submit')).toBeEnabled();
    expect(create.requested()).toBe(false);
  } finally {
    confirmation.resolve();
    create.release();
  }
});

for (const planAvailable of [false, true]) {
  test(`[P0] Home restores the wallet memory gate with Coding Plan available=${planAvailable}`, async ({ page }, testInfo) => {
    await wireSignedInAmrHome(page, { accountBalanceUsd: '0.00' });
    const create = await holdProjectCreate(page);
    const confirmation = deferred();
    let sending = false;
    const { workspaceId, workspaceMemberId } = AMR_PERSONAL_WORKSPACE_CONTEXT;
    const displayed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workspace/billing'
      && new URL(response.url()).searchParams.get('scope') === 'workspace' && response.ok());
    await page.route('**/api/workspace/billing?**', async (route) => {
      // Older than the independent hint TTL; the Home gate must consume the
      // billing projection already maintained for the rail, not a warmed hint.
      const generatedAt = new Date(Date.now() - 31_000).toISOString();
      await route.fulfill({ json: {
        summary: null,
        workspaceBalance: { workspaceId, workspaceMemberId, billingScopeVersion: 2, balanceUsd: '0', updatedAt: generatedAt, expiresAt: null },
        preflight: {
          schemaVersion: 1, workspaceId, workspaceMemberId, modelId: null, generatedAt,
          balanceUsd: '0', funding: planAvailable ? 'coding_plan' : 'gateway', modelCovered: null,
          codingPlan: { workspaceId, generatedAt, eligible: planAvailable, tier: planAvailable ? 'go' : null,
            windows: planAvailable ? [{ policyId: '5h', durationSeconds: 18000, resetMode: 'activity_triggered',
              usedCredits: '0', limitCredits: '100', remainingCredits: '100', windowStart: null, resetsAt: null }] : [] },
        },
      } });
    });
    await page.route('**/api/workspace/billing/preflight?**', async (route) => {
      if (sending) await confirmation.promise;
      await route.fulfill({ json: { preflight: null } });
    });
    try {
      await gotoEntryHome(page);
      await displayed;
      const prompt = 'Use the displayed wallet and plan before entering a project.';
      sending = true;
      await sendFromHome(page, prompt);
      if (planAvailable) {
        await expect(page.getByTestId('project-creation-pending-view')).toBeVisible();
        await expect(page.getByTestId('amr-balance-dialog')).toHaveCount(0);
        await expect.poll(() => create.requested()).toBe(true);
      } else {
        const dialog = page.getByTestId('amr-balance-dialog');
        await expect(dialog).toBeVisible();
        await expect(page.getByTestId('home-hero-input')).toBeVisible();
        await expect(page.getByTestId('project-creation-pending-view')).toHaveCount(0);
        expect(create.requested()).toBe(false);
        await testInfo.attach('restored-home-memory-gate', { body: await page.screenshot({ animations: 'disabled' }), contentType: 'image/png' });
        // An old CLI/unreadable confirmation cannot strand this pending send.
        confirmation.resolve();
        await expect(dialog).toBeHidden();
        await expect.poll(() => create.requested()).toBe(true);
        await expect(page.getByTestId('project-creation-pending-view')).toBeVisible();
      }
    } finally {
      confirmation.resolve();
      create.release();
    }
  });
}
