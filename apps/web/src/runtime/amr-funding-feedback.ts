import type { AmrWalletSnapshot, WorkspaceBillingPreflightResponse } from '@open-design/contracts';
import { currentWorkspaceAccountGeneration } from '../collab/workspace-identity';
import type { AmrBalanceGateScope } from './amr-balance-gate';

type FundingFeedback = 'available' | 'insufficient' | 'unknown';
const pending = new Map<string, Promise<FundingFeedback>>();
let positive: { key: string; expiresAt: number } | null = null;
let homeBlock: { key: string; expiresAt: number; snapshot: AmrWalletSnapshot } | null = null;
let cacheGeneration = 0;
export const HOME_AMR_FUNDING_CACHE_TTL_MS = 30_000;

function fundingKey(scope: AmrBalanceGateScope, modelId: string | null): string {
  return JSON.stringify([cacheGeneration, currentWorkspaceAccountGeneration(), scope.workspaceType, scope.workspaceId, scope.workspaceMemberId, modelId]);
}

/** Home can hold navigation while confirming a short-lived negative or a
 * wallet-and-plan projection. A recent positive overrides either memory hint. */
export function cachedHomeAmrFundingBlock(
  scope: AmrBalanceGateScope | undefined,
  modelId: string | null,
  memorySnapshot: AmrWalletSnapshot | null = null,
): AmrWalletSnapshot | null {
  if (!scope) return null;
  const key = fundingKey(scope, modelId);
  if (positive?.key === key && positive.expiresAt > Date.now()) return null;
  if (homeBlock?.key === key && homeBlock.expiresAt > Date.now()) return homeBlock.snapshot;
  return memorySnapshot;
}

export function invalidateAmrFundingFeedback(): void {
  cacheGeneration++;
  positive = null;
  homeBlock = null;
}

/** Project sends always re-read negative evidence. Home separately peeks at a
 * short-lived negative to hold navigation and then confirms it with this read. */
export function checkAmrFundingFeedback(
  scope: AmrBalanceGateScope | undefined,
  modelId: string | null,
): Promise<FundingFeedback> {
  if (!scope) return Promise.resolve('unknown');
  const generation = currentWorkspaceAccountGeneration();
  const key = fundingKey(scope, modelId);
  if (positive?.key === key && positive.expiresAt > Date.now()) return Promise.resolve('available');
  const existing = pending.get(key);
  if (existing) return existing;
  const request = (async (): Promise<FundingFeedback> => {
    try {
      const query = new URLSearchParams({ workspaceId: scope.workspaceId });
      if (modelId) query.set('modelId', modelId);
      const response = await fetch(`/api/workspace/billing/preflight?${query}`, {
        cache: 'no-store', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return 'unknown';
      const { preflight } = await response.json() as WorkspaceBillingPreflightResponse;
      const age = Date.now() - Date.parse(preflight?.generatedAt);
      if (generation !== currentWorkspaceAccountGeneration() || key !== fundingKey(scope, modelId) || !preflight ||
        preflight.schemaVersion !== 1 || preflight.workspaceId !== scope.workspaceId ||
        preflight.workspaceMemberId !== scope.workspaceMemberId || preflight.modelId !== modelId ||
        !Number.isFinite(age) || age < -5_000 || age > 30_000) return 'unknown';
      if (preflight.fundingCheck === 'available') {
        if (homeBlock?.key === key) homeBlock = null;
        positive = { key, expiresAt: Date.now() + 5_000 };
        return 'available';
      }
      if (preflight.fundingCheck === 'insufficient') {
        const balance = preflight.balanceUsd?.trim();
        if (balance && Number.isFinite(Number(balance)) && Number(balance) <= 0) {
          homeBlock = {
            key,
            expiresAt: Math.min(Date.now(), Date.parse(preflight.generatedAt)) + HOME_AMR_FUNDING_CACHE_TTL_MS,
            snapshot: {
              status: 'available', profile: 'default', user: null, balanceUsd: balance,
              updatedAt: preflight.generatedAt, fetchedAt: new Date().toISOString(),
              stale: false, source: 'daemon_cache',
            },
          };
        }
        return 'insufficient';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  })();
  pending.set(key, request);
  void request.finally(() => pending.delete(key));
  return request;
}
