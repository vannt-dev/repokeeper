import { ACCESS_LEVELS } from "../gitlab/settings.js";
import { STACK_IDS } from "./types.js";

const flag = { type: "boolean" } as const;
const ACCESS = Object.keys(ACCESS_LEVELS);

export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "standard", "platform", "stacks"],
  properties: {
    schema: { const: 1 },
    standard: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    platform: { enum: ["github", "gitlab"] },
    stacks: { type: "array", minItems: 1, uniqueItems: true, items: { enum: [...STACK_IDS] } },
    modules: {
      type: "object",
      additionalProperties: false,
      properties: {
        editorconfig: flag,
        commits: flag,
        hooks: flag,
        ci: flag,
        release: flag,
        deps: flag,
        gitignore: flag,
        drift: flag,
        health: {
          anyOf: [
            { const: false },
            {
              type: "object",
              additionalProperties: false,
              required: ["license", "copyright", "contact", "codeowners"],
              properties: {
                license: { anyOf: [{ const: false }, { type: "string", minLength: 1 }] },
                copyright: { type: "string", minLength: 1 },
                contact: { type: "string", minLength: 1 },
                codeowners: { type: "array", items: { type: "string", pattern: "^@" } },
              },
            },
          ],
        },
      },
    },
    owned: { type: "array", items: { type: "string", minLength: 1 } },
    stack_options: { type: "object" },
    github: {
      type: "object",
      additionalProperties: false,
      properties: {
        default_branch: { type: "string", minLength: 1 },
        workflows: {
          type: "object",
          additionalProperties: false,
          properties: {
            // "local", or the owner/name of a repository holding a copy of the reusable workflows
            source: { type: "string", pattern: "^(local|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$" },
            // "exact", or a tag, branch or commit SHA
            ref: { type: "string", pattern: "^[A-Za-z0-9_./-]+$" },
          },
        },
        description: { type: "string" },
        topics: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,49}$" } },
        merge: {
          type: "object",
          additionalProperties: false,
          properties: { squash: flag, merge_commit: flag, rebase: flag, delete_branch_on_merge: flag },
        },
        security: {
          type: "object",
          additionalProperties: false,
          properties: { dependabot_alerts: flag, dependabot_security_updates: flag },
        },
        protect: {
          anyOf: [
            { const: false },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                require_pull_request: flag,
                required_approvals: { type: "integer", minimum: 0, maximum: 10 },
                required_checks: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
                allow_force_push: flag,
              },
            },
          ],
        },
      },
    },
    gitlab: {
      type: "object",
      additionalProperties: false,
      properties: {
        default_branch: { type: "string", minLength: 1 },
        description: { type: "string" },
        topics: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } },
        merge: {
          type: "object",
          additionalProperties: false,
          properties: {
            method: { enum: ["merge", "rebase_merge", "ff"] },
            squash: { enum: ["never", "always", "default_on", "default_off"] },
            delete_source_branch: flag,
            pipeline_must_succeed: flag,
            discussions_must_be_resolved: flag,
          },
        },
        protect: {
          anyOf: [
            { const: false },
            {
              type: "object",
              additionalProperties: false,
              properties: { push: { enum: ACCESS }, merge: { enum: ACCESS }, allow_force_push: flag },
            },
          ],
        },
        // five cron fields, read in UTC; false removes the schedule repokeeper made
        renovate_schedule: { anyOf: [{ const: false }, { type: "string", pattern: "^\\S+( \\S+){4}$" }] },
      },
    },
  },
} as const;
