import { describe, expect, it } from "vitest";
import { parseJsonObjectText } from "../src/llm.js";

describe("structured LLM output", () => {
  it("accepts a plain JSON object", () => {
    expect(parseJsonObjectText('{"shots":[]}')).toEqual({ shots: [] });
  });

  it("accepts a fenced JSON object without weakening object validation", () => {
    expect(parseJsonObjectText('```json\n{"score":8}\n```')).toEqual({ score: 8 });
  });

  it("rejects invalid text instead of manufacturing an empty object", () => {
    expect(() => parseJsonObjectText("not json at all")).toThrow(/valid JSON object/);
  });

  it("rejects JSON arrays because workflow stage contracts require objects", () => {
    expect(() => parseJsonObjectText("[]")).toThrow(/valid JSON object/);
  });
});
