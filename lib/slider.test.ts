import { describe, expect, it } from 'vitest';
import { analyzeRows } from './analysis.ts';
import { runtimeSliderNames } from './runtime-sliders.ts';
import { sliderBounds, sliderForm, sliderValue, withBounds, writeSlider } from './slider.ts';

describe('sliderForm', () => {
  it('reads plain numbers as before', () => {
    expect(sliderForm('2')).toMatchObject({ literal: 2, whole: false });
    expect(sliderForm(' -0.5 ')).toMatchObject({ literal: -0.5, start: 1, end: 5 });
    expect(sliderForm('1e-3')).toBeNull();
    expect(sliderForm('a + 1')).toBeNull();
  });

  it('reads a range from clamp', () => {
    expect(sliderForm('clamp(0.433, 0, 1)')).toMatchObject({ literal: 0.433, whole: false, bounds: { lo: '0', hi: '1' } });
    expect(sliderForm(' clamp( 3 , -pi, 2 b ) ')).toMatchObject({ literal: 3, bounds: { lo: '-pi', hi: '2 b' } });
    expect(sliderForm('clamp(0.4, max(a, 1), 2)')).toMatchObject({ bounds: { lo: 'max(a, 1)', hi: '2' } });
  });

  it('reads whole steps from round, floor and ceil, alone or with clamp', () => {
    expect(sliderForm('round(4)')).toMatchObject({ literal: 4, whole: true });
    expect(sliderForm('floor(4)')).toMatchObject({ whole: true });
    expect(sliderForm('round(clamp(30, 0, 255))')).toMatchObject({ literal: 30, whole: true, bounds: { lo: '0', hi: '255' } });
    expect(sliderForm('clamp(ceil(3), 0, 9)')).toMatchObject({ literal: 3, whole: true, bounds: { lo: '0', hi: '9' } });
  });

  it('leaves anything else a computed constant', () => {
    expect(sliderForm('clamp(a, 0, 1)')).toBeNull();
    expect(sliderForm('clamp(0.4, 0)')).toBeNull();
    expect(sliderForm('clamp(0.4, 0, 1) + 1')).toBeNull();
    expect(sliderForm('round(1) + round(2)')).toBeNull();
    expect(sliderForm('round(round(2))')).toBeNull();
    expect(sliderForm('clamp(clamp(1, 0, 2), 0, 3)')).toBeNull();
    expect(sliderForm('sin(2)')).toBeNull();
  });

  it('is not fooled by a function of the user\'s own', () => {
    expect(sliderForm('clamp(0.4, 0, 1)', new Set(['clamp']))).toBeNull();
    expect(sliderForm('round(4)', new Set(['round']))).toBeNull();
  });
});

describe('writing back', () => {
  it('replaces only the literal', () => {
    const rhs = ' round( clamp(30 , 0, 255) )';
    expect(writeSlider(rhs, sliderForm(rhs)!, '110')).toBe(' round( clamp(110 , 0, 255) )');
    expect(writeSlider('2', sliderForm('2')!, '3.5')).toBe('3.5');
  });

  it('writes typed ends as a clamp, or replaces the ends it has', () => {
    expect(withBounds('2', sliderForm('2')!, '0', '5')).toBe('clamp(2, 0, 5)');
    expect(withBounds('round(2)', sliderForm('round(2)')!, '0', '5')).toBe('round(clamp(2, 0, 5))');
    const rhs = 'round(clamp(30, 0, 255))';
    expect(withBounds(rhs, sliderForm(rhs)!, '-1', '1')).toBe('round(clamp(30, -1, 1))');
  });

  it('holds values to the range and step', () => {
    const form = sliderForm('round(clamp(30, 0, 255))')!;
    const bounds = sliderBounds(form, {});
    expect(bounds).toEqual([0, 255]);
    expect(sliderValue(form, 300, bounds)).toBe(255);
    expect(sliderValue(form, 29.6, bounds)).toBe(30);
    const free = sliderForm('clamp(0.5, 0, b)')!;
    expect(sliderBounds(free, { b: 2 })).toEqual([0, 2]);
    expect(sliderBounds(free, { b: -1 })).toBeNull();
    expect(sliderBounds(free, {})).toBeNull();
  });
});

describe('in a graph', () => {
  it('a clamp constant is the value it says', () => {
    const a = analyzeRows(['a = clamp(5, 0, 1)', 'b = round(clamp(2.4, 0, 9))', 'c = clamp(-3, -1, 1)', 'a + b + c']);
    expect(a.constEnv).toMatchObject({ a: 1, b: 2, c: -1 });
    expect(a.rows[3].info).toBe('= 2');
  });

  it('clamp is a function everywhere, and a definition may take the name', () => {
    const a = analyzeRows(['y = clamp(x, -1, 1)']);
    expect(a.rows[0].error).toBeUndefined();
    const b = analyzeRows(['clamp(p, q, r) = p q r', 'clamp(1, 2, 3)']);
    expect(b.rows[1].info).toBe('= 6');
    expect(analyzeRows(['clamp(1, 2)']).rows[0].error).toMatch(/three arguments/);
  });

  it('ranged sliders still move at runtime', () => {
    const a = analyzeRows(['a = clamp(0.4, 0, 1)', 'n = round(3)', 'y = a x + n']);
    expect(runtimeSliderNames(a)).toEqual(new Set(['a', 'n']));
  });
});
