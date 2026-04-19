import assert from 'node:assert/strict';
import { test } from 'node:test';

globalThis.location = new URL('http://127.0.0.1/');

function makeButton(active = false) {
  const classes = new Set(active ? ['active'] : []);
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, force) {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
          return classes.has(name);
        }
        if (force) classes.add(name);
        else classes.delete(name);
        return !!force;
      },
      contains(name) { return classes.has(name); },
    },
  };
}

const nodes = new Map();
const stage = makeButton();
stage.classList.add('measuring');
stage.classList.add('roi-mode');
nodes.set('view-xform', stage);
for (const id of ['btn-measure', 'btn-angle', 'btn-annot', 'btn-ask', 'btn-roi-ell', 'btn-roi-poly', 'btn-slimsam']) {
  nodes.set(id, makeButton(true));
}

globalThis.document = {
  getElementById(id) {
    return nodes.get(id) || null;
  },
};

const { state } = await import('../js/state.js');
const { deactivate2dAuthoringTools } = await import('../js/two-d-tools.js');
const { toggleMeasure } = await import('../js/measure.js');
const { toggleAngle } = await import('../js/angle.js');
const { toggleAnnotate } = await import('../js/annotation.js');
const { toggleAskMode } = await import('../js/consult-ask.js');

test('deactivate2dAuthoringTools clears 2d-only modes and tool chrome', () => {
  state.measureMode = true;
  state.measurePending = { x: 1, y: 2 };
  state.angleMode = true;
  state.anglePending = [{ x: 1, y: 2 }];
  state.annotateMode = true;
  state.askMode = true;

  deactivate2dAuthoringTools();

  assert.equal(state.measureMode, false);
  assert.equal(state.measurePending, null);
  assert.equal(state.angleMode, false);
  assert.equal(state.anglePending, null);
  assert.equal(state.annotateMode, false);
  assert.equal(state.askMode, false);
  assert.equal(nodes.get('view-xform').classList.contains('measuring'), false);
  assert.equal(nodes.get('view-xform').classList.contains('roi-mode'), false);
  for (const id of ['btn-measure', 'btn-angle', 'btn-annot', 'btn-ask', 'btn-roi-ell', 'btn-roi-poly', 'btn-slimsam']) {
    assert.equal(nodes.get(id).classList.contains('active'), false);
  }
});

test('2d-only tool toggles do not activate outside 2d mode', () => {
  state.mode = 'cmp';
  state.measureMode = false;
  state.angleMode = false;
  state.annotateMode = false;
  state.askMode = false;

  assert.equal(toggleMeasure(), false);
  assert.equal(toggleAngle(), false);
  assert.equal(toggleAnnotate(), false);
  assert.equal(toggleAskMode(), false);
  assert.equal(state.measureMode, false);
  assert.equal(state.angleMode, false);
  assert.equal(state.annotateMode, false);
  assert.equal(state.askMode, false);
});
