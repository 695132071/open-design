// @vitest-environment jsdom
//
// OPEND-3146: the Home type row keeps 原型 / 动效设计 / 幻灯片 inline and folds
// EVERY other artifact type into 更多, in one product-fixed order. Nothing an
// earlier row offered may be lost to the fold, and the fold's order is a
// product list, not catalog order.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TypePillRow } from '../../../src/components/home-hero/TypePillRow';
import {
  HOME_HERO_CHIPS,
  HOME_TYPE_ROW_IDS,
  HOME_TYPE_ROW_MORE_IDS,
  orderedCreateChips,
} from '../../../src/components/home-hero/chips';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const EXPECTED_MORE_ORDER = [
  'image',
  'document',
  'hyperframes',
  'web-clone',
  'video',
  'audio',
  'live-artifact',
  'webgl',
];

function renderRow() {
  const onPick = vi.fn();
  render(
    <TypePillRow
      chips={orderedCreateChips()}
      activeChipId={null}
      labelFor={(id) => id}
      onPick={onPick}
    />,
  );
  return { onPick };
}

describe('TypePillRow — 更多 (OPEND-3146)', () => {
  it('keeps the three lead types inline and lists the other types behind 更多 in product order', () => {
    expect([...HOME_TYPE_ROW_IDS]).toEqual(['prototype', 'motion-design', 'deck']);
    expect([...HOME_TYPE_ROW_MORE_IDS]).toEqual(EXPECTED_MORE_ORDER);

    renderRow();
    for (const id of HOME_TYPE_ROW_IDS) {
      expect(screen.getByTestId(`home-hero-type-pill-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('home-hero-type-pills-popover')).toBeNull();

    fireEvent.click(screen.getByTestId('home-hero-type-pills-more'));
    const popover = screen.getByTestId('home-hero-type-pills-popover');
    const ids = Array.from(popover.querySelectorAll('button')).map((button) =>
      button.getAttribute('data-chip'),
    );
    expect(ids).toEqual(EXPECTED_MORE_ORDER);
  });

  it('covers every create type between the row and 更多 — nothing is retired', () => {
    const reachable = new Set([...HOME_TYPE_ROW_IDS, ...HOME_TYPE_ROW_MORE_IDS]);
    const createIds = orderedCreateChips().map((chip) => chip.id);
    expect(createIds.filter((id) => !reachable.has(id))).toEqual([]);
  });

  it('carries each create type once in the catalog — the fold must not read a stale duplicate', () => {
    const createIds = HOME_HERO_CHIPS.filter((chip) => chip.group === 'create').map((chip) => chip.id);
    const duplicates = createIds.filter((id, index) => createIds.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  it('picks a 更多 entry and closes the popover', () => {
    const { onPick } = renderRow();
    fireEvent.click(screen.getByTestId('home-hero-type-pills-more'));
    fireEvent.click(screen.getByTestId('home-hero-type-pill-webgl-more'));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'webgl' }));
    expect(screen.queryByTestId('home-hero-type-pills-popover')).toBeNull();
  });

  it('enters the menu with arrow keys, navigates its items and restores focus on Escape', () => {
    renderRow();
    const trigger = screen.getByTestId('home-hero-type-pills-more');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const first = screen.getByTestId('home-hero-type-pill-image-more');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-document-more'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-webgl-more'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-webgl-more'));
  });

  it('enters an already open menu without closing it, and supports keyboard activation', () => {
    renderRow();
    const trigger = screen.getByTestId('home-hero-type-pills-more');
    trigger.focus();
    fireEvent.click(trigger, { detail: 1 });
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-image-more'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.click(trigger, { detail: 0 });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-image-more'));
  });

  it('stops at either end instead of wrapping, and can move back into the list', () => {
    renderRow();
    fireEvent.keyDown(screen.getByTestId('home-hero-type-pills-more'), { key: 'ArrowDown' });
    const first = screen.getByTestId('home-hero-type-pill-image-more');
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-document-more'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    const last = screen.getByTestId('home-hero-type-pill-webgl-more');
    fireEvent.keyDown(last, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('home-hero-type-pill-live-artifact-more'));
  });

  it('scrolls only enough to reveal each keyboard-focused item, in both directions', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    renderRow();
    fireEvent.keyDown(screen.getByTestId('home-hero-type-pills-more'), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    vi.spyOn(list, 'clientHeight', 'get').mockReturnValue(205);
    vi.spyOn(list, 'scrollHeight', 'get').mockReturnValue(364);
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 200, 205));
    const items = screen.getAllByRole('option');
    const focusSpies = items.map((item, index) => {
      vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() =>
        new DOMRect(100, 100 + index * 46 - list.scrollTop, 200, 42));
      return vi.spyOn(item, 'focus');
    });
    for (const [index, scrollTop] of [0, 0, 0, 21, 67, 113, 159].entries()) {
      fireEvent.keyDown(items[index]!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[index + 1]);
      expect(focusSpies[index + 1]).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(list.scrollTop).toBe(scrollTop);
    }
    for (const [index, scrollTop] of [159, 159, 159, 138, 92, 46, 0].entries()) {
      fireEvent.keyDown(items[7 - index]!, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[6 - index]);
      expect(list.scrollTop).toBe(scrollTop);
    }
    fireEvent.keyDown(items[0]!, { key: 'End' });
    expect(list.scrollTop).toBe(159);
    fireEvent.keyDown(items[7]!, { key: 'Home' });
    expect(list.scrollTop).toBe(0);
  });

  it('retargets rapid arrow presses and cancels scrolling when the menu closes', () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    const pump = (now: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(now));
    };
    renderRow();
    fireEvent.keyDown(screen.getByTestId('home-hero-type-pills-more'), { key: 'ArrowDown' });
    const list = screen.getByRole('listbox');
    vi.spyOn(list, 'clientHeight', 'get').mockReturnValue(205);
    vi.spyOn(list, 'scrollHeight', 'get').mockReturnValue(364);
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 200, 205));
    const items = screen.getAllByRole('option');
    items.forEach((item, index) => vi.spyOn(item, 'getBoundingClientRect').mockImplementation(() =>
      new DOMRect(100, 100 + index * 46 - list.scrollTop, 200, 42)));
    for (let index = 0; index < 8; index++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[7]);
    expect(frames.size).toBe(1);
    pump(0);
    pump(30);
    expect(list.scrollTop).toBeGreaterThan(0);
    expect(list.scrollTop).toBeLessThan(159);
    // Reverse before the first animation finishes; old targets must not win.
    for (let index = 0; index < 7; index++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    expect(frames.size).toBe(1);
    pump(40);
    pump(160);
    expect(list.scrollTop).toBe(0);
    expect(frames.size).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(frames.size).toBe(1);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(frames.size).toBe(0);
  });

  it('flips an open menu above the trigger when resizing leaves too little room below', () => {
    vi.stubGlobal('innerHeight', 900);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(364);
    renderRow();
    const trigger = screen.getByTestId('home-hero-type-pills-more');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 500, 80, 38));
    fireEvent.click(trigger);
    const popover = screen.getByTestId('home-hero-type-pills-popover');
    expect(popover.getAttribute('data-side')).toBe('bottom');
    expect(screen.getByRole('listbox').style.maxHeight).toBe('205px');

    vi.stubGlobal('innerHeight', 650);
    fireEvent.resize(window);
    expect(popover.getAttribute('data-side')).toBe('top');
    expect(screen.getByRole('listbox').style.maxHeight).toBe('205px');
    fireEvent.click(screen.getByTestId('home-hero-type-pill-document-more'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('constrains the menu to the roomier side when neither side fits its full height', () => {
    vi.stubGlobal('innerHeight', 350);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(364);
    renderRow();
    const trigger = screen.getByTestId('home-hero-type-pills-more');
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 180, 80, 38));
    fireEvent.click(trigger);
    expect(screen.getByTestId('home-hero-type-pills-popover').getAttribute('data-side')).toBe('top');
    expect(screen.getByRole('listbox').style.maxHeight).toBe('138px');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
