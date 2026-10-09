export interface PlaygroundInput {
  platform: "github" | "gitlab";
  stacks: Array<{ id: string; directory?: string }>;
  /** One switch per module; `health` is on or off, its details are in `health`. */
  modules: Record<string, boolean>;
  health: { license: boolean; copyright: string; contact: string; codeowners: string };
  defaultBranch: string;
  workflows: { mode: "default" | "exact" | "ref" | "mirror" | "local"; ref: string; source: string };
  protect: { enabled: boolean; approvals: number | string };
  security: boolean;
}

export const STANDARD: string;
export const NEEDS_VERSION: string;
export const STACKS: Array<{ id: string; label: string }>;
export const PLATFORM_STACKS: Record<"github" | "gitlab", string[]>;
export const PRESETS: Array<{ id: string; summary: string }>;
export const MODULES: Array<{ id: string; label: string; hint: string }>;
export const PLACEHOLDERS: { copyright: string; contact: string; codeowners: string };
export function presetModules(preset: string): Record<string, boolean>;
export function presetInput(preset: string, platform?: "github" | "gitlab"): PlaygroundInput;
export function buildConfig(input: PlaygroundInput): Record<string, unknown>;
export function problems(input: PlaygroundInput): string[];
export function matchingPreset(input: PlaygroundInput): string | null;
export function shortcutCommand(input: PlaygroundInput): string | null;
export function fileCommands(input: PlaygroundInput): string[];
export function renderConfig(config: Record<string, unknown>): string;
