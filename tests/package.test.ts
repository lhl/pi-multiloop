import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const skill = readFileSync(new URL("../skills/multiloop/SKILL.md", import.meta.url), "utf8");

describe("pi package resources", () => {
  it("declares a discoverable multiloop skill", () => {
    expect(packageJson.pi.skills).toEqual(["./skills"]);
    expect(skill).toMatch(/^---\r?\nname: multiloop\r?\n/);
    expect(skill).toContain("license: MIT");
    expect(skill).toContain("references/LOOP_GUIDE.md");
  });
});
