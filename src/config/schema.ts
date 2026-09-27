import { STACK_IDS } from "./types.js";

const flag = { type: "boolean" } as const;

export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "standard", "platform", "stacks"],
  properties: {
    schema: { const: 1 },
    standard: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
    platform: { enum: ["github"] },
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
  },
} as const;
