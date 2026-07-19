import { describe, expect, test } from "vitest";
import { VERSION } from "../src/index.js";

describe("scaffold", () => {
  test("exports a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
