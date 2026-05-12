import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectPolicyEvidence,
  createPolicyAttestation,
  policyDocumentHash,
} from "./policy-state.js";
import { evaluatePolicyTrustedToolCall } from "./runtime-tool-policy.js";

let workspaceDir: string;

function cfg(settings: Record<string, unknown> = {}, entryEnabled = true) {
  return {
    plugins: {
      entries: {
        policy: {
          enabled: entryEnabled,
          config: { runtimeToolPolicy: true, ...settings },
        },
      },
    },
  };
}

async function evaluate(
  toolName: string,
  settings: Record<string, unknown> = {},
  entryEnabled = true,
) {
  return evaluatePolicyTrustedToolCall(
    { toolName, params: {} },
    {},
    {
      cwd: workspaceDir,
      readConfig: () => cfg(settings, entryEnabled),
    },
  );
}

function acceptedAttestationHash(params: {
  readonly policy: unknown;
  readonly toolsRaw: string;
  readonly settings?: Record<string, unknown>;
}): string {
  const policyHash = policyDocumentHash(params.policy);
  const evidence = collectPolicyEvidence(cfg(params.settings ?? {}) as Record<string, unknown>, {
    toolsRaw: params.toolsRaw,
  });
  const attestationHash = createPolicyAttestation({
    ok: true,
    checkedAt: "2026-05-12T00:00:00.000Z",
    policyPath: "policy.jsonc",
    policyHash,
    evidence,
    findings: [],
  }).attestationHash;
  if (attestationHash === undefined) {
    throw new Error("expected policy attestation hash");
  }
  return attestationHash;
}

describe("policy trusted tool runtime", () => {
  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(join(tmpdir(), "policy-runtime-"));
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does nothing until runtime tool policy is enabled", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { settings: { runtimeToolPolicy: true, requireRisk: true } } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy", { runtimeToolPolicy: false })).resolves.toBeUndefined();
  });

  it("honors plugin entry enablement without requiring config.enabled", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { settings: { requireRisk: true } } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy requires risk metadata for 'deploy', but TOOLS.md does not declare it.",
    });
  });

  it("honors explicit policy disablement", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { settings: { requireRisk: true } } }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy", { enabled: false })).resolves.toBeUndefined();
  });

  it("blocks when the enabled runtime policy file is missing", async () => {
    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy tool runtime is enabled, but policy.jsonc is missing.",
    });
  });

  it("blocks when the enabled runtime policy file is malformed", async () => {
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), "{ tools: ", "utf-8");
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:low\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy tool runtime is enabled, but policy.jsonc could not be parsed.",
    });
  });

  it("blocks when the enabled runtime policy file has invalid containers", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({ tools: { entries: {} } }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:low\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason:
        "Policy tool runtime is enabled, but policy.jsonc has an invalid tools.entries section.",
    });
  });

  it("blocks tool calls whose required metadata is missing", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n\n### deploy\n", "utf-8");

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason: "Policy requires risk metadata for 'deploy', but TOOLS.md does not declare it.",
    });
  });

  it("blocks tool calls whose risk metadata is unknown", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critcal\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toEqual({
      block: true,
      blockReason:
        "Policy requires known risk metadata for 'deploy', but TOOLS.md declares 'critcal'.",
    });
  });

  it("requires approval for critical or irreversible tools", async () => {
    const policy = {
      tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
    };
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critical sensitivity:internal IRREVERSIBLE_EXTERNAL\n",
      "utf-8",
    );

    await expect(evaluate("deploy")).resolves.toMatchObject({
      requireApproval: {
        title: "Review policy-governed tool",
        severity: "critical",
        metadata: {
          source: "policy",
          policy: {
            path: "policy.jsonc",
            hash: policyDocumentHash(policy),
          },
          workspace: {
            scope: "policy",
            hash: expect.stringMatching(/^sha256:/),
          },
          target: "oc://TOOLS.md/tools/deploy",
        },
      },
    });
  });

  it("blocks when watched tool evidence no longer matches the accepted attestation", async () => {
    const policy = {
      tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
    };
    const acceptedTools = "## Tools\n\n### deploy risk:low sensitivity:internal\n";
    const expectedAttestationHash = acceptedAttestationHash({
      policy,
      toolsRaw: acceptedTools,
    });
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### deploy risk:critical sensitivity:internal\n",
      "utf-8",
    );

    const result = await evaluate("deploy", { expectedAttestationHash });

    expect(result).toMatchObject({
      block: true,
      blockReason: expect.stringContaining(
        `policy.jsonc no longer matches the accepted policy attestation`,
      ),
    });
    expect((result as { blockReason?: string }).blockReason).toContain(
      `expected ${expectedAttestationHash}`,
    );
  });

  it("includes matching attestation metadata in runtime approvals", async () => {
    const policy = {
      tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
    };
    const toolsRaw =
      "## Tools\n\n### deploy risk:critical sensitivity:internal IRREVERSIBLE_EXTERNAL\n";
    const expectedAttestationHash = acceptedAttestationHash({ policy, toolsRaw });
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), toolsRaw, "utf-8");

    await expect(evaluate("deploy", { expectedAttestationHash })).resolves.toMatchObject({
      requireApproval: {
        metadata: {
          source: "policy",
          attestation: {
            hash: expectedAttestationHash,
            expectedHash: expectedAttestationHash,
          },
          workspace: {
            scope: "policy",
            hash: expect.stringMatching(/^sha256:/),
          },
        },
      },
    });
  });

  it("includes policy metadata when undeclared tools need approval", async () => {
    const policy = {
      tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
    };
    const expectedHash = policyDocumentHash(policy);
    await fs.writeFile(join(workspaceDir, "policy.jsonc"), JSON.stringify(policy), "utf-8");
    await fs.writeFile(join(workspaceDir, "TOOLS.md"), "## Tools\n", "utf-8");

    await expect(evaluate("deploy", { expectedHash })).resolves.toMatchObject({
      requireApproval: {
        title: "Review undeclared tool",
        metadata: {
          source: "policy",
          policy: {
            path: "policy.jsonc",
            hash: expectedHash,
            expectedHash,
          },
          workspace: {
            scope: "policy",
            hash: expect.stringMatching(/^sha256:/),
          },
          target: "oc://TOOLS.md/tools/deploy",
        },
      },
    });
  });

  it("allows declared low-risk tools without a runtime decision", async () => {
    await fs.writeFile(
      join(workspaceDir, "policy.jsonc"),
      JSON.stringify({
        tools: { settings: { runtimeToolPolicy: true, requireRisk: true } },
      }),
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceDir, "TOOLS.md"),
      "## Tools\n\n### inspect risk:low sensitivity:public\n",
      "utf-8",
    );

    await expect(evaluate("inspect")).resolves.toBeUndefined();
  });
});
