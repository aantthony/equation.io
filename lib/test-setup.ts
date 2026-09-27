/**
 * Runs before every test file (vitest.config.ts setupFiles).
 *
 * Measurements over continuous sets (lib/measure.ts) end on a deterministic
 * work budget, with a wall-clock stop as a safety net for a slow device. A
 * test checks what the budget gives, so the clock is turned off here: a slow
 * or cold runner then gets the same answer as a fast one. (measure.test.ts
 * turns it back on where the stop itself is under test.)
 */
import { setMeasureHardStop } from './measure.ts';

setMeasureHardStop(Infinity);
