import * as THREE from './vendor-three.js';
import { TrackballControls } from './vendor-trackball-controls.js';

import { $ } from './dom.js';
import { setThreeDView } from './volume-3d-views.js';
import { show3DHover } from './volume-3d-hover.js';
import {
  getThreeRuntime,
  setThreeRuntimeShell,
  setThreeRuntimeRenderFns,
} from './runtime/viewer-runtime.js';

/**
 * Creates renderer, scene, camera, TrackballControls, render loop, resize,
 * pointer safety nets, and 3D canvas hover. Installs shell via setThreeRuntimeShell.
 */
export function ensureThreeRenderer(deps) {
  const { is3dActive, hideHover } = deps;
  const three = getThreeRuntime();

  const container = $('three-container');
  const w = container.clientWidth || window.innerWidth - 480;
  const h = container.clientHeight || window.innerHeight - 90;
  if (three.renderer) {
    three.renderer.setSize(w, h);
    three.camera.aspect = w / h;
    three.camera.updateProjectionMatrix();
    if (three.controls.handleResize) three.controls.handleResize();
    if (three.requestRender) three.requestRender('resize');
    return;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(w, h);
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(2.2, 1.8, 2.2);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 3.0;
  controls.zoomSpeed = 1.5;
  controls.panSpeed = 1.0;
  controls.dynamicDampingFactor = 0.15;
  controls.noPan = false;
  controls.noZoom = false;
  controls.noRotate = false;

  window.addEventListener('pointerup', (e) => {
    if (is3dActive() && renderer.domElement.isConnected) {
      renderer.domElement.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: e.pointerId, pointerType: e.pointerType,
        clientX: e.clientX, clientY: e.clientY, bubbles: false,
      }));
    }
  });
  window.addEventListener('blur', () => {
    if (is3dActive() && renderer.domElement.isConnected) {
      renderer.domElement.dispatchEvent(new PointerEvent('pointerup', {
        pointerId: 1, pointerType: 'mouse', bubbles: false,
      }));
    }
  });

  let rafId = 0;
  let loopUntil = 0;
  function scheduleFrame() {
    if (rafId) return;
    rafId = requestAnimationFrame(renderFrame);
  }
  function renderFrame() {
    rafId = 0;
    if (!is3dActive()) return;
    controls.update();
    renderer.render(scene, camera);
    if (Date.now() < loopUntil) scheduleFrame();
  }
  function requestRender(_reason = 'update', burstMs = 0) {
    if (!is3dActive()) return;
    if (burstMs > 0) loopUntil = Math.max(loopUntil, Date.now() + burstMs);
    scheduleFrame();
  }
  function startLoop() {
    requestRender('start-loop', 220);
  }
  function stopLoop() {
    loopUntil = 0;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }
  function renderNow() {
    if (!is3dActive()) return;
    renderer.render(scene, camera);
  }
  controls.addEventListener('start', () => requestRender('controls-start', 500));
  controls.addEventListener('change', () => requestRender('controls-change', 220));
  controls.addEventListener('end', () => requestRender('controls-end', 160));
  setThreeRuntimeShell({ renderer, scene, camera, controls, startLoop });
  setThreeRuntimeRenderFns({ startLoop, stopLoop, requestRender, renderNow });
  startLoop();

  window.addEventListener('resize', () => {
    const wx = window.innerWidth - 480, hx = window.innerHeight - 90;
    renderer.setSize(wx, hx);
    camera.aspect = wx / hx;
    camera.updateProjectionMatrix();
    requestRender('window-resize', 120);
  });

  renderer.domElement.addEventListener('dblclick', (e) => {
    e.preventDefault();
    setThreeDView('reset');
    requestRender('dblclick-view', 160);
  });

  let hoverThrottle = 0;
  renderer.domElement.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - hoverThrottle < 66) return;
    hoverThrottle = now;
    show3DHover(e, renderer, camera);
  });
  renderer.domElement.addEventListener('mouseleave', hideHover);
}
