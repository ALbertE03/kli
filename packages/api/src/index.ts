/**
 * @kli/api — frozen public contracts.
 *
 * Plugins import ONLY from this package (Rule #1). Never from @kli/kernel.
 */

// Capabilities
export { CapabilitySet, CapabilitySchema, type Capability, type Capabilities } from "./capabilities.js";

// Manifest
export {
  PluginKindSet,
  PluginKindSchema,
  type PluginKind,
  PluginManifestSchema,
  type PluginManifest,
} from "./manifest.js";

// Context (PluginContext, Budget, Logger)
export { BudgetSchema, type Budget, type Logger, type PluginContext } from "./context.js";

// Plugin
export { validatePluginShape, type HarnessPlugin } from "./plugin.js";

// Registry / TaskRegistry
export {
  type Registry,
  type TaskRegistry,
} from "./registry.js";

// Tool
export {
  ToolResultOkSchema,
  ToolResultErrorSchema,
  ToolResultSchema,
  ToolErrorCodeSet,
  ToolErrorCodeSchema,
  type ToolResult,
  type ToolDefinition,
  type ToolView,
  type JsonSchema,
  type ToolErrorCode,
  toJsonSchema,
} from "./tool.js";

// Policy
export {
  PolicyDecisionSchema,
  type PolicyDecision,
  type Policy,
  type ToolCallView,
} from "./policy.js";

// Provider
export {
  type Provider,
  type ProviderHooks,
  type StepResult,
  type ToolInvocation,
  type ModelInfo,
} from "./provider.js";

// Backend / CodeGraph
export {
  BackendCapabilitiesSchema,
  type BackendCapabilities,
  DetectionResultSchema,
  type DetectionResult,
  BuildOptionsSchema,
  type BuildOptions,
  SymbolKindSet,
  SymbolKindSchema,
  type SymbolKind,
  SymbolNodeSchema,
  type SymbolNode,
  EdgeKindSet,
  EdgeKindSchema,
  type EdgeKind,
  SymbolEdgeSchema,
  type SymbolEdge,
  LanguageStatsSchema,
  type LanguageStats,
  type AstBackend,
  type CodeGraph,
  type BackendInfo,
} from "./backend.js";

// Prompt
export {
  PromptPositionSet,
  PromptPositionSchema,
  type PromptPosition,
  type PromptFragment,
  type PromptFragmentContent,
  type PromptContext,
  type GraphSummary,
  type SkillDescriptor,
  type McpServerInfo,
  type BudgetSummary,
} from "./prompt.js";

// Skills (single source of truth: skill.ts)
export {
  SkillTriggerKeywordSchema,
  SkillTriggerFileSchema,
  SkillTriggerCommandSchema,
  SkillTriggerManualSchema,
  SkillTriggerSchema,
  type SkillTrigger,
  SkillManifestSchema,
  type SkillManifest,
} from "./skill.js";

// Modes & Events
export {
  ModeSet,
  ModeSchema,
  type Mode,
  type ModePolicy,
  defineModePolicy,
} from "./mode.js";

// Agents (subagents)
export {
  AgentDefinitionSchema,
  AgentsFileSchema,
  agentPromptFragment,
  createDelegationTool,
  defaultAgents,
  mergeAgents,
  toAgentSummary,
  type AgentDefinition,
  type AgentsFile,
  type AgentSummary,
  type AgentRunResult,
  type AgentRunHooks,
  type DelegationArgs,
  type DelegationDeps,
  type DelegationToolOptions,
} from "./agent.js";
export {
  EventSchema,
  type Event,
  type EventType,
  type Handler,
  type Bus,
  TaskStartedSchema,
  ModeChangedSchema,
  PluginLoadedSchema,
  PluginRejectedSchema,
  PluginReloadedSchema,
  McpServerConnectedSchema,
  McpServerFailedSchema,
  SkillActivatedSchema,
  ToolCalledSchema,
  ToolCompletedSchema,
  ToolProgressSchema,
  ModelRequestSchema,
  ModelResponseSchema,
  ContextCompactedSchema,
  PolicyTriggeredSchema,
  TaskFinishedSchema,
} from "./bus.js";

// TaskState
export {
  ToolCallSchema,
  MessageSchema,
  type TaskState,
  type Message,
  type ToolCall,
} from "./task.js";
