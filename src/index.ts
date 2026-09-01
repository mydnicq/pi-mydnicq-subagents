import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadProjectAgents, type AgentDefinition } from "./loader.ts";

const subagentSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to run" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
});

export type SubagentToolInput = Static<typeof subagentSchema>;

function describeAgent(agent: AgentDefinition): string {
  return [
    `Agent "${agent.name}"`,
    agent.description,
    `model: ${agent.model} · thinking: ${agent.thinking} · context: ${agent.context}`,
    `system prompt: ${agent.systemPrompt.length} chars`,
  ].join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a named subagent. Subagents are defined as Markdown files with YAML frontmatter in the project's .pi/agents directory; the file name defines the agent name.",
    parameters: subagentSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) {
        return {
          content: [{ type: "text", text: "Project is not trusted — refusing to read .pi/agents." }],
          details: {},
        };
      }

      const result = loadProjectAgents(ctx.cwd);
      const agent = result.agents.get(params.agent);
      if (!agent) {
        const available = result.agents.size > 0 ? [...result.agents.keys()].join(", ") : "(none)";
        const problems = [...result.errors, ...result.warnings]
          .map((d) => `- ${d.file}: ${d.message}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: `Unknown subagent "${params.agent}". Available: ${available}.\nDefine agents in ${result.agentsDir}/<name>.md${problems ? `\n\nLoad problems:\n${problems}` : ""}`,
            },
          ],
          details: {},
        };
      }

      // Delegation is not wired up yet; report the resolved config for now.
      return {
        content: [{ type: "text", text: describeAgent(agent) }],
        details: { agent },
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return;
    const result = loadProjectAgents(ctx.cwd);
    for (const d of result.errors) ctx.ui.notify(`${d.file}: ${d.message}`, "error");
    for (const d of result.warnings) ctx.ui.notify(`${d.file}: ${d.message}`, "warning");
    if (result.agents.size > 0) {
      ctx.ui.notify(`Loaded ${result.agents.size} subagent(s) from .pi/agents`, "info");
    }
  });

  // /subagents — list the agents the loader found
  pi.registerCommand("subagents", {
    description: "List configured subagents (.pi/agents)",
    handler: async (_args, ctx) => {
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Project is not trusted — .pi/agents not loaded.", "warning");
        return;
      }
      const result = loadProjectAgents(ctx.cwd);
      if (result.agents.size === 0) {
        ctx.ui.notify(`No subagents found in ${result.agentsDir}`, "info");
        return;
      }
      const lines = [...result.agents].map(
        ([name, a]) => `${name} — ${a.description} [${a.model}]`
      );
      for (const d of result.errors) ctx.ui.notify(`${d.file}: ${d.message}`, "error");
      for (const d of result.warnings) ctx.ui.notify(`${d.file}: ${d.message}`, "warning");
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}