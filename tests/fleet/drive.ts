// Driving the screen in tests: a frame as rows of text, and a state reached by pressing keys.
import { frame, initialScreen, press, type ScreenSource } from "../../src/fleet/screen.js";

export const text = (src: ScreenSource, st = initialScreen(), cols = 80, rows = 24) => frame(src, st, cols, rows).map((l) => l.map((s) => s.text).join(""));
export const keys = (src: ScreenSource, ...ks: string[]) => ks.reduce((st, k) => press(src, st, k).state, initialScreen());
export const keysFrom = (src: ScreenSource, from: ReturnType<typeof initialScreen>, ...ks: string[]) => ks.reduce((st, k) => press(src, st, k).state, from);
