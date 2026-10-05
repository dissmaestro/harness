import type { Settings } from "./settings.ts";

/**
 * Model profiles and roles. A profile fills in what a model family needs (sampling, thinking switches);
 * roles let parts of the agent use different settings: another model, or the same model without
 * thinking for quick jobs (summaries, side questions).
 */

export interface Sampling {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
}

export interface ThinkingConfig {
  /** chat_template_kwargs.enable_thinking (undefined: don't send) */
  enabled?: boolean;
  /**
   * Send the model's earlier reasoning back in the history (chat_template_kwargs.preserve_thinking and a
   * reasoning field on assistant messages). "turn": only within the current task (keeps the agent loop
   * coherent at a bounded context cost), "all": the whole conversation, "off": never.
   */
  preserve?: "turn" | "all" | "off";
}

export interface RoleConfig {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  /** false: this role runs without thinking (faster); true/undefined: as the main settings */
  thinking?: boolean;
  sampling?: Sampling;
}

/** "main", "compact" (history summaries), "aside" (questions while agents work), or a subagent type */
export type Role = string;

export interface ResolvedRequest {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  sampling: Sampling;
  chatTemplateKwargs?: Record<string, unknown>;
  /** which assistant messages carry their reasoning back to the server */
  preserve: "turn" | "all" | "off";
  extraBody?: Record<string, unknown>;
}

interface Profile {
  sampling: Sampling;
  /** sampling when thinking is off for a role */
  instructSampling: Sampling;
  thinking: ThinkingConfig;
  roles: Record<string, RoleConfig>;
}

const QWEN_INSTRUCT: Sampling = { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 };

/** Values from the Qwen model cards ("precise coding" for thinking mode). */
export const PROFILES: Record<string, Profile> = {
  // Qwen3.6 is trained to reuse its earlier reasoning in agent loops (preserve_thinking); without it the
  // template drops past <think> blocks and tool calls tend to loop with empty arguments after a few turns.
  "qwen3.6": {
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 },
    instructSampling: QWEN_INSTRUCT,
    thinking: { enabled: true, preserve: "turn" },
    roles: { compact: { thinking: false }, aside: { thinking: false } },
  },
  qwen3: {
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
    instructSampling: QWEN_INSTRUCT,
    thinking: { enabled: true, preserve: "off" },
    roles: { compact: { thinking: false }, aside: { thinking: false } },
  },
  none: { sampling: {}, instructSampling: {}, thinking: {}, roles: {} },
};

/** "auto" picks a profile from the model name; models behind aliases (e.g. "smart") need "profile" set. */
export function profileName(settings: Pick<Settings, "profile" | "model">): string {
  const p = settings.profile ?? "auto";
  if (p !== "auto") return PROFILES[p] ? p : "none";
  if (/qwen3[._-]?6/i.test(settings.model)) return "qwen3.6";
  if (/qwen3/i.test(settings.model)) return "qwen3";
  return "none";
}

const defined = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/** The effective request settings for a role: profile defaults < settings < role overrides. */
export function resolveRequest(settings: Settings, role: Role = "main"): ResolvedRequest {
  const profile = PROFILES[profileName(settings)];
  const roleCfg: RoleConfig = { ...profile.roles[role], ...defined(settings.roles?.[role]) };
  const thinking: ThinkingConfig = { ...profile.thinking, ...defined(settings.thinking) };
  const thinkingOn = roleCfg.thinking === false ? false : thinking.enabled;
  const base: Sampling = thinkingOn === false ? profile.instructSampling : profile.sampling;
  const sampling: Sampling = {
    ...base,
    ...defined(settings.sampling),
    ...(settings.temperature !== undefined && { temperature: settings.temperature }),
    ...defined(roleCfg.sampling),
  };
  const preserve = thinkingOn === false ? "off" : (thinking.preserve ?? "off");
  const kwargs: Record<string, unknown> = {};
  if (thinkingOn !== undefined) kwargs.enable_thinking = thinkingOn;
  if (thinkingOn !== false && thinking.preserve !== undefined) kwargs.preserve_thinking = preserve !== "off";
  return {
    baseUrl: roleCfg.baseUrl ?? settings.baseUrl,
    model: roleCfg.model ?? settings.model,
    apiKey: roleCfg.apiKey ?? settings.apiKey,
    maxTokens: roleCfg.maxTokens ?? settings.maxTokens,
    sampling,
    chatTemplateKwargs: Object.keys(kwargs).length ? kwargs : undefined,
    preserve,
    extraBody: settings.extraBody,
  };
}
