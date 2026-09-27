/**
 * The motion sensor behind `device.gravity`, fed to lib/device.ts. It runs
 * only while the document reads it. Where the browser gates motion behind a
 * permission (iOS), it asks on the first tap or key press — the only place
 * iOS allows the question — and says so in a notice on a phone.
 */
import { STANDARD_GRAVITY, setDeviceInput } from '../lib/device.ts';

type Notice = (text: string) => void;

const RAD = Math.PI / 180;

/** Gravity in the device's frame from its orientation angles (Z-X'-Y''
 *  Euler, per the DeviceOrientation spec): the down vector, rotated into the
 *  screen. Angles rather than accelerationIncludingGravity, whose sign iOS and
 *  Android report opposite ways, and which shakes with every movement. */
function gravityFrom(beta: number, gamma: number, screenAngle: number): number[] {
  const b = beta * RAD;
  const c = gamma * RAD;
  const dx = Math.cos(b) * Math.sin(c);
  const dy = -Math.sin(b);
  const dz = -Math.cos(b) * Math.cos(c);
  // The screen turned by `screenAngle` counterclockwise from the device's
  // natural orientation: its axes are the device's, turned by the same.
  const s = screenAngle * RAD;
  const x = dx * Math.cos(s) - dy * Math.sin(s);
  const y = dx * Math.sin(s) + dy * Math.cos(s);
  return [x, y, dz].map(v => v * STANDARD_GRAVITY);
}

function onOrientation(e: DeviceOrientationEvent) {
  // No sensor: null angles (desktop Chrome), or exact zeros (headless and
  // emulated ones). A real phone lying flat is never exactly 0, 0; taken as
  // flat, gravity would leave the screen's plane and a pendulum would float.
  if (e.beta === null || e.gamma === null || (e.beta === 0 && e.gamma === 0)) return;
  setDeviceInput('gravity', gravityFrom(e.beta, e.gamma, screen.orientation?.angle ?? 0));
}

/** iOS's gate on motion: a permission asked for inside a gesture. */
const motionPermission = (): (() => Promise<string>) | undefined =>
  typeof DeviceOrientationEvent === 'undefined'
    ? undefined
    : (DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }).requestPermission?.bind(
        DeviceOrientationEvent,
      );

/** Listening, or waiting for the gesture that may start listening. */
let state: 'off' | 'waiting' | 'on' = 'off';

function listen() {
  state = 'on';
  addEventListener('deviceorientation', onOrientation);
}

function onGesture(notice: Notice) {
  const handler = () => {
    removeEventListener('pointerdown', handler, true);
    removeEventListener('keydown', handler, true);
    if (state !== 'waiting') return;
    void motionPermission()!()
      .catch(() => 'denied')
      .then(answer => {
        if (state !== 'waiting') return;
        if (answer === 'granted') listen();
        else {
          state = 'off';
          notice('Motion access was refused, so device.gravity points straight down.');
        }
      });
  };
  addEventListener('pointerdown', handler, true);
  addEventListener('keydown', handler, true);
}

/** Listen to the motion sensor while the document reads device.gravity. */
export function syncMotion(wanted: boolean, notice: Notice): void {
  if (!wanted) {
    if (state === 'on') removeEventListener('deviceorientation', onOrientation);
    if (state !== 'off') setDeviceInput('gravity');
    state = 'off';
    return;
  }
  if (state !== 'off') return;
  if (!motionPermission()) return listen();
  state = 'waiting';
  onGesture(notice);
  // A desktop has no tilt to offer, and device.gravity there already points down.
  if (matchMedia('(pointer: coarse)').matches) notice("Tap the graph to let device.gravity follow your phone's tilt.");
}
