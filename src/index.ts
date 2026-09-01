import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const subagentSchema = Type.Object({
  agent: Type.String({ description: "Name of the agent to run" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
});

export type SubagentToolInput = Static<typeof subagentSchema>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate a task to a named subagent.",
    parameters: subagentSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [
          {
            type: "text",
            text: `Not implemented yet: would run agent "${params.agent}" on task: ${params.task}`,
          },
        ],
        details: {},
      };
    },
  });
}