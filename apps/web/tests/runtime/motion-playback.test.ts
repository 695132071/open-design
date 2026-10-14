// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { injectMotionSourcePlayer, MOTION_PREVIEW_ACTIVITY, MOTION_PREVIEW_REQUEST } from '@open-design/contracts/runtime/motion-source-player';

type MotionWindow = Window & {
  __odMotionSourcePlayer?: boolean;
  __odMotionPreview?: boolean;
  __odMotionThumbnail?: boolean;
  __timelines?: Record<string, unknown>;
  __odMotionPlayer?: { state(): { playing: boolean }; pause(): void; play(): void; setMuted(value: boolean): void };
};
const motionWindow = window as MotionWindow;
let dispose: (() => void) | undefined;
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'));
  dispose?.();
  delete motionWindow.__odMotionSourcePlayer;
  delete motionWindow.__odMotionPreview;
  delete motionWindow.__odMotionThumbnail;
  delete motionWindow.__odMotionPlayer;
  delete motionWindow.__timelines;
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function boot(hosted: boolean, playResult: Promise<void> = Promise.resolve(), thumbnail = false) {
  vi.useFakeTimers();
  const listeners = vi.spyOn(window, 'addEventListener');
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  document.head.innerHTML = '<meta name="od-motion-output" content="video">';
  document.body.innerHTML = '<main data-composition-id="main" data-duration="15" data-width="1920" data-height="1080"><audio src="sound.wav" data-duration="15"></audio></main>';
  const audio = document.querySelector('audio')!;
  let audioPaused = true;
  Object.defineProperties(audio, { paused: { get: () => audioPaused }, readyState: { value: 4 } });
  vi.spyOn(audio, 'play').mockImplementation(() => { audioPaused = false; return playResult; });
  vi.spyOn(audio, 'pause').mockImplementation(() => { audioPaused = true; });
  let time = 0, paused = false;
  const timeline = {
    time: () => time, duration: () => 15, timeScale: () => 1,
    repeat: () => 0, delay: () => 0, paused: () => paused,
    seek: (value: number) => { time = value; },
    play: () => { paused = false; }, pause: () => { paused = true; },
  };
  motionWindow.__timelines = { main: timeline };
  motionWindow.__odMotionPreview = hosted;
  motionWindow.__odMotionThumbnail = thumbnail;
  const html = injectMotionSourcePlayer(document.documentElement.outerHTML);
  const script = /<script data-od-motion-source-player[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
  window.eval(script!);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  dispose = () => {
    for (const [type, listener, options] of listeners.mock.calls) window.removeEventListener(type, listener, options);
  };
  const id = (post.mock.calls.find(([data]) => data.type === MOTION_PREVIEW_REQUEST)?.[0] as {id?: string} | undefined)?.id;
  const activity = (active: boolean, instance = id, source: MessageEventSource | null = window.parent) => {
    window.dispatchEvent(new MessageEvent('message', {source, data:{type:MOTION_PREVIEW_ACTIVITY, id:instance, active}}));
  };
  return { audio, timeline, activity, simulateDelayedStart: () => { audioPaused = false; }, player: motionWindow.__odMotionPlayer! };
}

it('keeps a hosted motion source and its audio paused until the host confirms it is active', () => {
  const { audio, timeline, player } = boot(true);
  expect(player.state().playing).toBe(false);
  expect(timeline.paused()).toBe(true);
  expect(audio.paused).toBe(true);
});

it('keeps standalone motion autoplay unchanged', () => {
  const { audio, timeline, player } = boot(false);
  expect(player.state().playing).toBe(true);
  expect(timeline.paused()).toBe(false);
  expect(audio.paused).toBe(false);
});

it('loops the thumbnail timeline while keeping its soundtrack paused and permanently muted', async () => {
  const { audio, timeline, player, activity } = boot(true, Promise.resolve(), true);
  activity(true);
  expect(player.state().playing).toBe(true);
  expect(timeline.paused()).toBe(false);
  expect(audio.paused).toBe(true);
  expect(audio.muted).toBe(true);
  expect(audio.play).not.toHaveBeenCalled();
  timeline.seek(15);
  await vi.advanceTimersByTimeAsync(34);
  expect(timeline.time()).toBe(0);
  expect(timeline.paused()).toBe(false);
  player.setMuted(false);
  expect(audio.muted).toBe(true);
  expect(audio.play).not.toHaveBeenCalled();
  activity(false);
  expect(timeline.paused()).toBe(true);
});

it('pauses audio and the timeline while hidden, blocks play while inactive and resumes when active', async () => {
  const { audio, timeline, player, activity } = boot(true);
  activity(true);
  expect(audio.paused).toBe(false);
  activity(false);
  player.play();
  await vi.advanceTimersByTimeAsync(1000);
  expect(player.state().playing).toBe(false);
  expect(timeline.paused()).toBe(true);
  expect(audio.paused).toBe(true);
  activity(true);
  expect(player.state().playing).toBe(true);
  expect(audio.paused).toBe(false);
});

it('preserves a user pause across hiding and reactivation', () => {
  const { audio, player, activity } = boot(true);
  activity(true);
  player.pause();
  activity(false);
  activity(true);
  expect(player.state().playing).toBe(false);
  expect(audio.paused).toBe(true);
});

it('does not activate on a stale document ID or a different message source', () => {
  const { audio, activity } = boot(true);
  activity(true, 'previous-document');
  activity(true, undefined, null);
  expect(audio.paused).toBe(true);
});

it('stops a late audio start after the preview was deactivated', async () => {
  let resolve!: () => void;
  const pending = new Promise<void>(r => { resolve = r; });
  const { audio, activity, simulateDelayedStart } = boot(true, pending);
  activity(true);
  expect(audio.play).toHaveBeenCalled();
  expect(vi.mocked(audio.play).mock.results[0]?.value).toBe(pending);
  activity(false);
  expect(motionWindow.__odMotionPlayer?.state().playing).toBe(false);
  simulateDelayedStart();
  resolve();
  await vi.waitFor(() => expect(audio.paused).toBe(true));
  expect(audio.paused).toBe(true);
});
