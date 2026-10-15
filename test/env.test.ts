import { describe, expect, it } from "vitest";
import { parseEnabledTools, parseHostnames } from "../src/env";

describe("parseEnabledTools", () => {
  it("returns null when unset or blank so every tool is enabled", () => {
    expect(parseEnabledTools(undefined)).toBeNull();
    expect(parseEnabledTools("")).toBeNull();
    expect(parseEnabledTools(" , ,")).toBeNull();
  });

  it("parses a comma-separated list and trims whitespace", () => {
    expect(parseEnabledTools("a, b ,c")).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("parseHostnames", () => {
  it("returns undefined when unset", () => {
    expect(parseHostnames(undefined)).toBeUndefined();
    expect(parseHostnames("")).toBeUndefined();
  });

  it("splits on commas", () => {
    expect(parseHostnames("mcp.example.com, sheets.example.com")).toEqual(["mcp.example.com", "sheets.example.com"]);
  });
});
