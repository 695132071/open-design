import { afterEach, describe, expect, it, vi } from 'vitest';
import { cachedHomeAmrFundingBlock, invalidateAmrFundingFeedback, HOME_AMR_FUNDING_CACHE_TTL_MS, checkAmrFundingFeedback } from '../../src/runtime/amr-funding-feedback';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../../src/collab/workspace-identity';

let sequence = 0;
function fixture(result: 'available' | 'insufficient' | 'unknown' | undefined) {
  const scope = { workspaceType: 'personal' as const, workspaceId: `ws-${++sequence}`, workspaceMemberId: 'member' };
  const preflight = { schemaVersion: 1, ...scope, modelId: 'model', generatedAt: new Date().toISOString(), fundingCheck: result, balanceUsd: '0' };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ preflight })));
  vi.stubGlobal('fetch', fetchMock);
  return { scope, preflight, fetchMock };
}

afterEach(() => { invalidateAmrFundingFeedback(); vi.unstubAllGlobals(); vi.useRealTimers(); resetWorkspaceAccountGeneration(); });
describe('independent AMR funding feedback', () => {
  it('uses the dedicated read without fetching display billing or creating a run', async () => {
    const { scope, fetchMock } = fixture('insufficient');
    expect(await checkAmrFundingFeedback(scope, 'model')).toBe('insufficient');
    expect(fetchMock).toHaveBeenCalledWith(`/api/workspace/billing/preflight?workspaceId=${scope.workspaceId}&modelId=model`, expect.objectContaining({ cache: 'no-store' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'unknown'] as const)('does not turn an old or uncertain server result (%s) into a rejection', async (result) => {
    const { scope } = fixture(result);
    expect(await checkAmrFundingFeedback(scope, 'model')).toBe('unknown');
  });
  it.each(['member', 'workspace', 'model', 'stale', 'future'] as const)('rejects %s evidence', async (change) => {
    const { scope, preflight } = fixture('insufficient');
    if (change === 'member') preflight.workspaceMemberId = 'other';
    if (change === 'workspace') preflight.workspaceId = 'other';
    if (change === 'model') preflight.modelId = 'other';
    if (change === 'stale') preflight.generatedAt = new Date(Date.now() - 60_000).toISOString();
    if (change === 'future') preflight.generatedAt = new Date(Date.now() + 60_000).toISOString();
    expect(await checkAmrFundingFeedback(scope, 'model')).toBe('unknown');
  });
  it('deduplicates concurrent reads but never reuses a negative result for a new send', async () => {
    const { scope, fetchMock } = fixture('insufficient');
    expect(await Promise.all([checkAmrFundingFeedback(scope, 'model'), checkAmrFundingFeedback(scope, 'model')])).toEqual(['insufficient', 'insufficient']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await checkAmrFundingFeedback(scope, 'model');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('briefly reuses positive evidence only for the same account, member and model', async () => {
    const { scope, fetchMock } = fixture('available');
    await checkAmrFundingFeedback(scope, 'model');
    await checkAmrFundingFeedback(scope, 'model');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advanceWorkspaceAccountGeneration('another-account');
    await checkAmrFundingFeedback(scope, 'model');
    await checkAmrFundingFeedback({ ...scope, workspaceMemberId: 'another-member' }, 'model');
    await checkAmrFundingFeedback(scope, 'other-model');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('expires positive hints after five seconds and reads the server again', async () => {
    vi.useFakeTimers();
    const { scope, preflight, fetchMock } = fixture('available');
    await checkAmrFundingFeedback(scope, 'model');
    vi.advanceTimersByTime(5_001);
    preflight.fundingCheck = 'insufficient';
    expect(await checkAmrFundingFeedback(scope, 'model')).toBe('insufficient');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('discards an in-flight result after the account changes', async () => {
    const { scope, preflight, fetchMock } = fixture('insufficient');
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = checkAmrFundingFeedback(scope, 'model');
    advanceWorkspaceAccountGeneration('new-account');
    finish(new Response(JSON.stringify({ preflight })));
    expect(await result).toBe('unknown');
  });
  it('leaves network failure unknown', async () => {
    const { scope, fetchMock } = fixture('insufficient');
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await checkAmrFundingFeedback(scope, 'model')).toBe('unknown');
  });
});


describe('Home cached funding gate', () => {
  it('peeks synchronously without network, scoped to account, member, workspace, type and model', async () => {
    const { scope, fetchMock } = fixture('insufficient');
    await checkAmrFundingFeedback(scope, 'model');
    expect(cachedHomeAmrFundingBlock(scope, 'model')).toMatchObject({ balanceUsd: '0', stale: false });
    expect(cachedHomeAmrFundingBlock(undefined, 'model')).toBeNull();
    expect(cachedHomeAmrFundingBlock({ ...scope, workspaceId: 'other' }, 'model')).toBeNull();
    expect(cachedHomeAmrFundingBlock({ ...scope, workspaceMemberId: 'other' }, 'model')).toBeNull();
    expect(cachedHomeAmrFundingBlock({ ...scope, workspaceType: 'team' }, 'model')).toBeNull();
    expect(cachedHomeAmrFundingBlock(scope, 'other')).toBeNull();
    advanceWorkspaceAccountGeneration('different-login');
    expect(cachedHomeAmrFundingBlock(scope, 'model')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('lets a recent available verdict override an older display-wallet block', async () => {
    const { scope } = fixture('available');
    const snapshot = { status: 'available' as const, profile: 'test', user: null, balanceUsd: '0',
      updatedAt: null, fetchedAt: new Date().toISOString(), stale: true, source: 'daemon_cache' as const };
    expect(cachedHomeAmrFundingBlock(scope, 'model', snapshot)).toBe(snapshot);
    await checkAmrFundingFeedback(scope, 'model');
    expect(cachedHomeAmrFundingBlock(scope, 'model', snapshot)).toBeNull();
  });
  it('expires negative evidence against its server timestamp, not just arrival time', async () => {
    vi.useFakeTimers();
    const { scope, preflight } = fixture('insufficient');
    preflight.generatedAt = new Date(Date.now() - 10_000).toISOString();
    await checkAmrFundingFeedback(scope, 'model');
    vi.advanceTimersByTime(HOME_AMR_FUNDING_CACHE_TTL_MS - 10_001);
    expect(cachedHomeAmrFundingBlock(scope, 'model')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(cachedHomeAmrFundingBlock(scope, 'model')).toBeNull();
  });
  it.each(['available', 'unknown', undefined] as const)('does not block zero-wallet users on %s', async (result) => {
    const { scope } = fixture(result);
    await checkAmrFundingFeedback(scope, 'model');
    expect(cachedHomeAmrFundingBlock(scope, 'model')).toBeNull();
  });
  it('clears the old negative even if confirmation fails', async () => {
    const { scope, fetchMock } = fixture('insufficient');
    await checkAmrFundingFeedback(scope, 'model');
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await checkAmrFundingFeedback(scope, 'model')).toBe('unknown');
    expect(cachedHomeAmrFundingBlock(scope, 'model')).toBeNull();
  });
  it('billing invalidation prevents an older in-flight read from restoring the block', async () => {
    const { scope, preflight, fetchMock } = fixture('insufficient');
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const request = checkAmrFundingFeedback(scope, 'model');
    invalidateAmrFundingFeedback();
    finish(new Response(JSON.stringify({ preflight })));
    expect(await request).toBe('unknown');
    expect(cachedHomeAmrFundingBlock(scope, 'model')).toBeNull();
  });
});
