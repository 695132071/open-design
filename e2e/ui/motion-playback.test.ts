import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@/playwright/suite';
import { ensureRailOpen } from '@/playwright/rail';
import type { Page } from '@playwright/test';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

function tone(seconds = 5) {
  const rate=16000, samples=rate*seconds;
  const wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(rate,24); wav.writeUInt32LE(rate*2,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
  wav.write('data',36); wav.writeUInt32LE(samples*2,40);
  for(let n=0;n<samples;n++) wav.writeInt16LE(Math.round(Math.sin(n*440*2*Math.PI/rate)*3000),44+n*2);
  return wav;
}

async function state(page: Page, id: string) {
  const frame=page.frames().find(f=>f.url().includes(`/projects/${id}/raw/index.html`));
  if(!frame) return null;
  return frame.evaluate(()=> {
    const player=(window as unknown as {__odMotionPlayer?: {state(): {playing:boolean;active:boolean;audio:{paused:boolean}[]}}}).__odMotionPlayer;
    return player?.state()??null;
  }).catch(()=>null);
}

test('[P1] motion audio stops in Code, inactive file tabs and the reloaded home cache', async ({page})=> {
  const config=await page.request.put('/api/app-config',{data:{onboardingCompleted:true,agentId:'mock',agentModels:{},agentCliEnv:{},skillId:null,designSystemId:null,odNextStrategyMode:'off'}});
  expect(config.ok()).toBe(true);
  const id=randomUUID();
  const created=await page.request.post('/api/projects',{data:{id,name:`Motion lifecycle ${id}`,metadata:{kind:'video',intent:'motion-design'}}});
  expect(created.ok(),await created.text()).toBe(true);
  const {conversationId}=await created.json() as {conversationId:string};
  const html='<!doctype html><html><head><meta name="od-motion-output" content="video"></head><body>'
    +'<main data-composition-id="main" data-duration="15" data-width="1920" data-height="1080"><h1>Motion lifecycle</h1><audio src="tone.wav" data-duration="5"></audio></main>'
    +'<script src="gsap.min.js"></script><script>var tl=gsap.timeline({paused:true});tl.to({clock:0},{clock:15,duration:15,ease:"none"},0);window.__timelines={main:tl};</script></body></html>';
  for(const [name,content] of [['index.html',Buffer.from(html)],['tone.wav',tone()],['gsap.min.js',await readFile(new URL('../../plugins/_official/examples/motion-showreel/assets/gsap.min.js',import.meta.url))]] as const) {
    const written=await page.request.post(`/api/projects/${id}/files`,{data:{name,content:content.toString('base64'),encoding:'base64'}});
    expect(written.ok(),await written.text()).toBe(true);
  }
  await page.addInitScript(()=>localStorage.setItem('open-design:config',JSON.stringify({mode:'daemon',agentId:'mock',onboardingCompleted:true,apiKey:'',baseUrl:'',model:''})));
  await page.goto(`/projects/${id}/conversations/${conversationId}/files/index.html`);
  await expect.poll(()=>state(page,id)).toMatchObject({active:true,playing:true,audio:[{paused:false}]});
  await page.getByRole('tab',{name:'Code',exact:true}).click();
  await expect.poll(()=>state(page,id)).toMatchObject({active:false,playing:false,audio:[{paused:true}]});
  await page.getByRole('tab',{name:'Preview',exact:true}).click();
  await expect.poll(()=>state(page,id)).toMatchObject({active:true,playing:true});
  await page.getByTestId('design-files-tab').click();
  await expect.poll(()=>state(page,id)).toMatchObject({active:false,playing:false,audio:[{paused:true}]});
  const thumbnail=page.frameLocator('.df-card-thumb iframe');
  await expect(thumbnail.locator('[data-composition-id]')).toBeAttached();
  await expect.poll(()=>thumbnail.locator('audio').evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
  await page.getByRole('tab',{name:/index\.html/}).click();
  await expect.poll(()=>state(page,id)).toMatchObject({active:true,playing:true});
  await page.getByTestId('workspace-home-chrome').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.iframe-keep-alive-pool iframe')).toHaveAttribute('data-od-active','false');
  await expect.poll(()=>state(page,id)).toMatchObject({active:false,playing:false,audio:[{paused:true}]});
  // A real iframe navigation while parked reproduces the second autoplay
  // race. Keep it hidden and require the newly loaded document to stay paused.
  const previous=page.frames().find(f=>f.url().includes(`/projects/${id}/raw/index.html`))!;
  const loaded=previous.waitForNavigation({waitUntil:'load'});
  await previous.evaluate(()=>location.reload());
  await loaded;
  await expect.poll(()=>state(page,id)).toMatchObject({active:false,playing:false,audio:[{paused:true}]});
  await ensureRailOpen(page);
  await page.getByRole('button',{name:`Motion lifecycle ${id}`,exact:true}).click();
  await expect.poll(()=>state(page,id)).toMatchObject({active:true,playing:true,audio:[{paused:false}]});
});


test('[P1] motion source sound follows pause, seek, timed effects, replay and looping', async ({ page }) => {
  const config = await page.request.put('/api/app-config', { data: { onboardingCompleted: true, agentId: 'mock', agentModels: {}, agentCliEnv: {}, skillId: null, designSystemId: null, odNextStrategyMode: 'off' } });
  expect(config.ok()).toBe(true);
  const id = randomUUID();
  const created = await page.request.post('/api/projects', { data: { id, name: `Motion controls ${id}`, metadata: { kind: 'video', intent: 'motion-design' } } });
  expect(created.ok(), await created.text()).toBe(true);
  const { conversationId } = await created.json() as { conversationId: string };
  const html = '<!doctype html><html><head><meta name="od-motion-output" content="video"></head><body>'
    + '<main data-composition-id="main" data-duration="12" data-width="640" data-height="360"><h1>Motion sound</h1><audio id="music" src="tone.wav" data-start="0" data-duration="12" data-volume="0.3"></audio><audio id="effect" src="tone.wav" data-start="3" data-duration="1" data-volume="0.6"></audio></main>'
    + '<script src="gsap.min.js"></script><script>var clock={t:0};window.__timelines={main:gsap.timeline({paused:true}).to(clock,{t:12,duration:12,ease:"none"},0)};</script></body></html>';
  for (const [name, content] of [['index.html', Buffer.from(html)], ['tone.wav', tone(12)], ['gsap.min.js', await readFile(new URL('../../plugins/_official/examples/motion-showreel/assets/gsap.min.js', import.meta.url))]] as const) {
    const written = await page.request.post(`/api/projects/${id}/files`, { data: { name, content: content.toString('base64'), encoding: 'base64' } });
    expect(written.ok(), await written.text()).toBe(true);
  }
  await page.addInitScript(() => localStorage.setItem('open-design:config', JSON.stringify({ mode: 'daemon', agentId: 'mock', onboardingCompleted: true, apiKey: '', baseUrl: '', model: '' })));
  await page.goto(`/projects/${id}/conversations/${conversationId}/files/index.html`);
  await expect.poll(() => state(page, id)).toMatchObject({ active: true, playing: true });
  const frame = page.frames().find(f => f.url().includes(`/projects/${id}/raw/index.html`))!;
  type Player = { play(): void; pause(): void; seek(time: number): void; replay(): void; setMuted(value: boolean): void; state(): { time: number } };
  const states = () => frame.locator('audio').evaluateAll(els => els.map(a => {
    const audio = a as HTMLAudioElement;
    return { paused: audio.paused, time: audio.currentTime, muted: audio.muted, volume: audio.volume };
  }));
  expect(await frame.locator('[data-od-motion-controls]').count()).toBe(0);
  await expect.poll(async () => (await states())[0]!.paused).toBe(false);
  expect((await states())[0]).toMatchObject({ muted: false, volume: 0.3 });
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.pause());
  expect((await states()).every(s => s.paused)).toBe(true);
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.seek(3.2));
  await expect.poll(async () => (await states())[1]!.time).toBeCloseTo(.2, 1);
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.play());
  await expect.poll(async () => (await states())[1]!.paused).toBe(false);
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.seek(.8));
  expect((await states())[1]).toMatchObject({ paused: true, time: 0 });
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.replay());
  await expect.poll(async () => (await states())[0]!.paused).toBe(false);
  expect((await states())[0]!.time).toBeLessThan(.5);
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.setMuted(true));
  expect((await states()).every(s => s.muted)).toBe(true);
  await frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.setMuted(false));
  expect((await states()).every(s => !s.muted)).toBe(true);
  await frame.evaluate(() => { const player = (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer; player.seek(11.9); player.play(); });
  await expect.poll(() => frame.evaluate(() => (window as unknown as { __odMotionPlayer: Player }).__odMotionPlayer.state().time)).toBeLessThan(1);
  await expect.poll(async () => (await states())[0]!.time).toBeLessThan(1);
});
