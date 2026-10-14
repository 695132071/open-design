import { findRealTagOffset, HTML_TAG_PATTERNS, prependAfterDoctype } from './html-injection-points';

export const MOTION_PREVIEW_OUTPUT_HEADER = 'x-od-motion-output';
export const MOTION_PLAYER_MARKER = 'data-od-motion-source-player';
export const MOTION_PREVIEW_REQUEST = 'od:motion-preview-request';
export const MOTION_PREVIEW_ACTIVITY = 'od:motion-preview-activity';
export const MOTION_PREVIEW_PROBE = 'od:motion-preview-probe';

// One clock contract for editable video playback and frame rendering. Check the
// authored timeline BEFORE HyperFrames can pad it or reset its playback speed.
export const MOTION_TIMELINE_CHECK_SCRIPT = `
window.__odValidateMotionTimeline = function (root, tl) {
  var mode = document.querySelector('meta[name="od-motion-output"]');
  if (!mode || mode.content !== 'video') return null;
  var seconds = Number(root && root.getAttribute('data-duration'));
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Motion video requires a positive data-duration.';
  if (!tl || typeof tl.duration !== 'function' || typeof tl.timeScale !== 'function') return 'Motion video requires a registered GSAP timeline.';
  if (!Number.isFinite(tl.timeScale()) || Math.abs(tl.timeScale() - 1) > 0.000001) return 'Motion video timeScale must be 1. Do not use duration(seconds) to stretch the timeline; author tracks in real seconds.';
  if (!Number.isFinite(tl.duration()) || Math.abs(tl.duration() - seconds) > 0.001) return 'Motion video timeline duration must equal data-duration. Add a clock tween at time 0 for the full duration; do not change playback speed.';
  if ((typeof tl.repeat === 'function' && tl.repeat() !== 0) || (typeof tl.delay === 'function' && tl.delay() !== 0)) return 'Motion video master timeline must have no repeat or delay.';
  return null;
};`;


// Shared by URL previews, srcdoc previews and the persisted editable source.
// The renderer installs its flag before author scripts; it never sees chrome,
// layout scaling, poster seeking, or wall-clock playback from this runtime.
const PLAYER = `<script data-od-motion-source-player="6">
${MOTION_TIMELINE_CHECK_SCRIPT}
(function () {
  function boot() {
    if (window.__odMotionRender || window.__odMotionSourcePlayer) return;
    var root = document.querySelector('[data-composition-id][data-duration][data-width][data-height]');
    var mode = document.querySelector('meta[name="od-motion-output"]');
    if (!root || (mode && mode.content === 'interactive')) return;
    window.__odMotionSourcePlayer = true;
    var width = Number(root.dataset.width), height = Number(root.dataset.height);
    if (!(width > 0 && height > 0)) return;
    var hint = document.createElement('output');
    hint.setAttribute('data-od-motion-status', ''); hint.setAttribute('role', 'status');
    hint.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;border-radius:6px;background:#17191d;color:white;font:13px system-ui;display:none';
    document.body.appendChild(hint);
    function notice(text) { hint.textContent = text; hint.style.display = text ? 'block' : 'none'; }
    var hosted = window.__odMotionPreview === true || new URL(location.href).searchParams.get('odMotionPreview') === '1';
    var thumbnail = window.__odMotionThumbnail === true || new URL(location.href).searchParams.get('odMotionThumbnail') === '1';
    var instance = Date.now().toString(36) + Math.random().toString(36).slice(2);
    var active = !hosted, playing = false, wantsPlay = true, pageActive = true, updateTimer = null;
    var applyPlayback = function () {};
    function requestActivity() { window.parent.postMessage({type:'${MOTION_PREVIEW_REQUEST}', id:instance, width:width, height:height}, '*'); }
    function onActivity(event) {
      var data = event.data;
      if (!hosted || event.source !== window.parent || !data) return;
      if (data.type === '${MOTION_PREVIEW_PROBE}') { requestActivity(); return; }
      if (data.type !== '${MOTION_PREVIEW_ACTIVITY}' || typeof data.active !== 'boolean' || (data.active && data.id !== instance)) return;
      active = data.active; applyPlayback();
    }
    window.addEventListener('message', onActivity);
    var tracks = Array.prototype.map.call(document.querySelectorAll('audio[src]'), function (audio) {
      audio.pause(); audio.autoplay = false;
      return { audio: audio, start: Number(audio.dataset.start || 0), duration: Number(audio.dataset.duration), volume: Number(audio.dataset.volume || 1), pending: false, blocked: false };
    });
    var muted = thumbnail;
    function syncAudio(time, shouldPlay, force) {
      tracks.forEach(function (track) {
        var audio = track.audio, local = time - track.start;
        if (thumbnail) { audio.muted = true; audio.pause(); return; }
        var trackActive = local >= 0 && local < track.duration;
        audio.volume = Math.max(0, Math.min(1, track.volume)); audio.muted = muted;
        if (!trackActive || !shouldPlay) audio.pause();
        var target = Math.max(0, Math.min(track.duration, local));
        if (audio.readyState > 0 && (force || Math.abs(audio.currentTime - target) > .2)) audio.currentTime = target;
        if (trackActive && shouldPlay && audio.paused && !track.pending && !track.blocked) {
          track.pending = true;
          var promise = audio.play();
          if (promise) promise.catch(function (error) {
            if (error && error.name === 'AbortError') return;
            track.blocked = true;
            notice(error && error.name === 'NotAllowedError' ? '点击画面开启声音' : '音频无法播放，请检查素材');
          }).finally(function () {
            track.pending = false;
            if (!active || !pageActive || !playing || !wantsPlay) audio.pause();
          });
          else track.pending = false;
        }
      });
    }
    var fitStyle = document.createElement('style');
    fitStyle.textContent = 'html,body{width:100% !important;height:100% !important;margin:0 !important;overflow:hidden !important}';
    document.head.appendChild(fitStyle);
    var stage = document.createElement('div');
    root.parentNode.insertBefore(stage, root); stage.appendChild(root);
    function fit() {
      var scale = Math.min(innerWidth / width, Math.max(1, innerHeight) / height);
      stage.style.cssText = 'position:fixed;width:' + width + 'px;height:' + height + 'px;left:' + ((innerWidth-width*scale)/2) + 'px;top:' + ((innerHeight-height*scale)/2) + 'px;transform-origin:0 0;transform:scale(' + scale + ')';
    }
    fit(); window.addEventListener('resize', fit);
    var started = Date.now();
    function connect() {
      var tl = window.__timelines && window.__timelines[root.dataset.compositionId];
      if (!tl || typeof tl.seek !== 'function' || typeof tl.play !== 'function' || !(tl.duration() > 0)) {
        if (Date.now()-started < 15000) { setTimeout(connect, 100); return; }
        notice('动效未就绪，请检查时间轴或依赖文件'); return;
      }
      var timingError = window.__odValidateMotionTimeline(root, tl);
      if (timingError) { tl.pause(); notice(timingError); return; }
      var duration = tl.duration();
      applyPlayback = function () {
        clearTimeout(updateTimer); updateTimer = null;
        playing = active && pageActive && wantsPlay;
        if (playing) {
          if (tl.time() >= duration) tl.seek(0, false);
          tl.play(); syncAudio(tl.time(), true, true); update();
        } else { tl.pause(); syncAudio(tl.time(), false, true); }
      };
      function play() { wantsPlay = true; applyPlayback(); }
      function pause() { wantsPlay = false; applyPlayback(); }
      function seek(time) { pause(); tl.seek(Math.max(0, Math.min(duration, Number(time))), false); syncAudio(tl.time(), false, true); }
      function replay() { seek(0); play(); }
      window.__odMotionPlayer = {
        play: play, pause: pause, seek: seek, replay: replay,
        setMuted: function (value) { muted = thumbnail || !!value; syncAudio(tl.time(), playing, false); },
        state: function () { return { playing: playing, active: active, time: tl.time(), duration: duration, muted: muted,
          audio: tracks.map(function (track) { return { paused: track.audio.paused, time: track.audio.currentTime, muted: track.audio.muted, volume: track.audio.volume, blocked: track.blocked }; }) }; }
      };
      root.addEventListener('click', function () {
        var blocked = tracks.some(function (track) { return track.blocked; });
        if (blocked) { tracks.forEach(function (track) { track.blocked = false; }); notice(''); if (playing) syncAudio(tl.time(), true, true); else play(); }
        else if (playing) pause(); else play();
      });
      tl.seek(0, false); applyPlayback();
      function update() {
        if (!stage.isConnected) { active = false; applyPlayback(); return; }
        if (!active || !pageActive || !playing) return;
        if (playing && tl.time() >= duration) { tl.seek(0, false); tl.play(); syncAudio(0, true, true); }
        syncAudio(tl.time(), playing && !tl.paused(), false);
        updateTimer = setTimeout(update, 33);
      }
    }
    window.addEventListener('pagehide', function () { pageActive = false; applyPlayback(); tracks.forEach(function (track) { track.audio.pause(); }); });
    window.addEventListener('pageshow', function () {
      pageActive = true;
      if (hosted) { active = false; requestActivity(); }
      applyPlayback();
    });
    if (hosted) requestActivity();
    connect();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once:true}); else boot();
})();
</script>`;

export function isMotionVideoComposition(html: string): boolean {
  const metaOffset = findRealTagOffset(html, /<meta\b[^>]*\bname\s*=\s*["']od-motion-output["']/i);
  const meta = metaOffset >= 0 ? /^<meta\b[^>]*>/i.exec(html.slice(metaOffset))?.[0] ?? '' : '';
  return /\bcontent\s*=\s*(?:["']video["']|video(?=\s|\/?>))/i.test(meta);
}

export function injectMotionSourcePlayer(html: string): string {
  if (!isMotionVideoComposition(html)) return html;
  // Runtime checks the actual DOM too; these prefilters avoid adding code to
  // ordinary prototypes/decks and do not mistake JS samples for HTML tags.
  if (findRealTagOffset(html, /<[^/!][^>]*\bdata-composition-id\s*=/i) < 0) return html;
  const existing = findRealTagOffset(html, /<script\b[^>]*\bdata-od-motion-source-player\b/i);
  if (existing >= 0) {
    const script = /^<script\b[^>]*>[\s\S]*?<\/script\s*>/i.exec(html.slice(existing));
    if (!script || /data-od-motion-source-player="6"/.test(script[0])) return html;
    return html.slice(0, existing) + PLAYER + html.slice(existing + script[0].length);
  }
  const end = findRealTagOffset(html, HTML_TAG_PATTERNS.bodyClose);
  return end < 0 ? html + PLAYER : html.slice(0, end) + PLAYER + html.slice(end);
}

export function markMotionFrameRender(html: string): string {
  return prependAfterDoctype(html, '<script>window.__odMotionRender=true;</script>');
}

/** Only live embedded previews wait for host activity; exports and standalone
 * editable sources retain their existing autoplay/render behavior. */
export function markMotionHostedPreview(html: string): string {
  return isMotionVideoComposition(html)
    ? prependAfterDoctype(html, '<script>window.__odMotionPreview=true;</script>')
    : html;
}
