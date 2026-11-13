import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { readDisabledSkillNames } from "./user-skill-prefs";

/**
 * Build a `skillsOverride` for DefaultResourceLoader that honors the current
 * user's temporary skill disables (FR-4.6).
 *
 * A user-disabled skill keeps its file on disk (the admin's distributed content
 * is never touched) and stays explicitly invocable via `/skill:name`; it is only
 * hidden from the model's system prompt, exactly like the frontmatter
 * `disable-model-invocation` switch. That is enforced by forcing
 * `disableModelInvocation: true` on the in-memory skill record, so no shared
 * file is rewritten.
 *
 * Returns `undefined` when no skill is disabled, so single-user and untouched
 * accounts keep the SDK's default loader behavior byte-for-byte.
 */
export function userSkillsOverride(
  agentDir: string,
): ((base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
}) | undefined {
  const disabled = readDisabledSkillNames(agentDir);
  if (disabled.size === 0) return undefined;
  return (base) => ({
    ...base,
    skills: base.skills.map((skill) =>
      disabled.has(skill.name) && !skill.disableModelInvocation
        ? { ...skill, disableModelInvocation: true }
        : skill,
    ),
  });
}
