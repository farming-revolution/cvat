// Copyright (C) 2026 Farming Revolution
// SPDX-License-Identifier: MIT
// Run in an isolated Playwright page with all API writes blocked. The caller loads
// a point-track job and sets window.__prof={store, actions} via cvatUI.registerComponent.
// This exercises the rendered canvas, real mouse dragging and keyboard undo/redo.
module.exports = async function verifySinglePointControls(page) {
  const result = await page.evaluate(async () => {
    const a = __prof.store.getState().annotation,
      canvas = a.canvas.instance;
    const states = a.annotations.states,
      state = states.find(s => s.shapeType === 'points' && s.points.length === 2 && !s.outside);
    const before = JSON.stringify(await a.job.instance.annotations.export());
    const checks = [];
    const assert = (v, msg) => {
      if (!v) throw Error(msg);
      checks.push(msg);
    };
    const tick = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const group = () => document.getElementById(`cvat_canvas_shape_${state.clientID}`);
    const initial = group();
    const circle = initial.querySelector('circle');
    let revision = state.updated;
    async function render(overrides) {
      overrides = {
        ...overrides,
        updated: ++revision
      };
      const proxy = new Proxy(state, {
        get: (target, key) => key in overrides ? overrides[key] : Reflect.get(target, key)
      });
      canvas.setup(a.player.frame.data, states.map(s => s === state ? proxy : s));
      await tick();
      return proxy;
    }
    function aligned() {
      const g = group(),
        base = document.getElementById(g.getAttribute('data-polyline-id'));
      // Some CVAT polylines have no DOM id; use the selection handler's shape from the group instance.
      const poly = base || Array.from(document.querySelectorAll('polyline')).find(p => p.instance?.remember('_selectHandler')?.nested?.node === g);
      if (!poly) throw Error('Missing polyline');
      const xy = poly.getAttribute('points').trim().split(/[ ,]+/).map(Number);
      const expected = new DOMPoint(xy[0], xy[1]).matrixTransform(poly.getScreenCTM());
      const c = g.querySelector('circle');
      const actual = new DOMPoint(+c.getAttribute('cx'), +c.getAttribute('cy')).matrixTransform(c.getScreenCTM());
      assert(Math.hypot(expected.x - actual.x, expected.y - actual.y) < 0.1, 'point handle follows coordinates');
    }
    await render({
      points: [state.points[0] + 25, state.points[1] + 35]
    });
    assert(group() === initial && group().querySelector('circle') === circle, 'single point reuses group and circle');
    aligned();
    await render({
      points: state.points,
      occluded: true
    });
    assert(group().classList.contains('cvat_canvas_shape_occluded'), 'occlusion updates');
    aligned();
    await render({
      hidden: true
    });
    assert(group().classList.contains('cvat_canvas_hidden'), 'hidden updates');
    await render({
      hidden: false,
      points: [state.points[0] + 55, state.points[1] + 5]
    });
    assert(!group().classList.contains('cvat_canvas_hidden'), 'unhide updates');
    aligned();
    await render({
      outside: true
    });
    assert(group().classList.contains('cvat_canvas_hidden'), 'outside updates');
    await render({
      outside: false
    });
    aligned();
    await render({
      points: [...state.points, state.points[0] + 30, state.points[1] + 40]
    });
    assert(group().querySelectorAll('circle').length === 2, 'multipoint topology rebuilds');
    await render({
      points: state.points
    });
    assert(group().querySelectorAll('circle').length === 1, 'single point topology restores');
    aligned();
    canvas.activate(state.clientID);
    await tick();
    assert(!!group(), 'selection remains available');
    canvas.activate(null);
    await tick();
    await render({
      lock: true
    });
    aligned();
    await render({
      lock: false
    });
    aligned();
    canvas.setup(a.player.frame.data, states);
    await tick();
    assert(JSON.stringify(await a.job.instance.annotations.export()) === before, 'visual tests do not change annotations');
    return {
      checks,
      clientID: state.clientID,
      buttons: document.querySelectorAll('.cvat-object-item-button-row').length
    };
  });
  console.log(JSON.stringify(result, null, 2));
  const drag = await page.evaluate(() => {
    const a = __prof.store.getState().annotation;
    const s = a.annotations.states.find(x => x.clientID === 1);
    const c = document.querySelector('#cvat_canvas_shape_1 circle');
    const r = c.getBoundingClientRect();
    return {
      points: s.points,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2
    };
  });
  await page.mouse.move(drag.x, drag.y);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move(drag.x + 20, drag.y + 15, {
    steps: 5
  });
  await page.mouse.up();
  await page.waitForFunction(original => {
    const s = __prof.store.getState().annotation.annotations.states.find(x => x.clientID === 1);
    return JSON.stringify(s.points) !== JSON.stringify(original);
  }, drag.points, {
    timeout: 5000
  });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(original => JSON.stringify(__prof.store.getState().annotation.annotations.states.find(x => x.clientID === 1).points) === JSON.stringify(original), drag.points, {
    timeout: 5000
  });
  await page.keyboard.press('Control+Shift+z');
  await page.waitForFunction(original => JSON.stringify(__prof.store.getState().annotation.annotations.states.find(x => x.clientID === 1).points) !== JSON.stringify(original), drag.points, {
    timeout: 5000
  });
  await page.keyboard.press('Control+z');
  console.log('Mouse drag, undo and redo passed, without saving');
  return result;
};
