import { describe, expect, it } from "vitest";
import { reportsCheck, workflowChecks } from "../src/github/checks.js";

const yaml = (...lines: string[]) => `${lines.join("\n")}\n`;

const CI = yaml(
  "on:",
  "  pull_request:",
  "  push:",
  "    branches: [main]",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "  result:",
  "    name: CI result",
  "    runs-on: ubuntu-latest",
  "  test:",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JS template
  "    name: test ${{ matrix.os }}",
  "    strategy:",
  "      matrix:",
  "        os: [ubuntu-latest, windows-latest]",
  "  build:",
  "    strategy:",
  "      matrix:",
  "        node: [22, 24]",
  "  node:",
  "    uses: vannt-dev/repokeeper/.github/workflows/stack-node.yml@v0",
);

describe("workflowChecks", () => {
  const checks = workflowChecks([CI]);

  it("reads a job's name, or its id without one", () => {
    expect(reportsCheck(checks, "CI result")).toBe(true);
    expect(reportsCheck(checks, "lint")).toBe(true);
    expect(reportsCheck(checks, "result")).toBe(false);
    expect(checks.pullRequests).toBe(true);
  });

  it("matches a name with an expression in it, and a matrix job's values", () => {
    expect(reportsCheck(checks, "test ubuntu-latest")).toBe(true);
    expect(reportsCheck(checks, "build (22)")).toBe(true);
    expect(reportsCheck(checks, "build")).toBe(true);
    expect(reportsCheck(checks, "deploy (22)")).toBe(false);
  });

  it("matches the checks of a job that calls a reusable workflow", () => {
    expect(reportsCheck(checks, "node / test (ubuntu-latest, 22)")).toBe(true);
    expect(reportsCheck(checks, "node")).toBe(true);
    expect(reportsCheck(checks, "nodes / test")).toBe(false);
  });

  it("leaves out workflows that only another calls, and files that are not YAML", () => {
    const called = yaml("on: workflow_call", "jobs:", "  inner:", "    name: Inner", "    runs-on: ubuntu-latest");
    const pushOnly = yaml("on: push", "jobs:", "  deploy:", "    runs-on: ubuntu-latest");
    const found = workflowChecks([called, "on: [", pushOnly]);
    expect(reportsCheck(found, "Inner")).toBe(false);
    expect(reportsCheck(found, "deploy")).toBe(true);
    expect(found.pullRequests).toBe(false);
  });
});
