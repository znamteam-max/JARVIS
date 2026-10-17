const CLAUDE_FAMILIES: Record<string, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
};

// Who wrote a chat answer, for the line under the bubble and the export:
// "claude-opus-5-5" → "Claude Opus 5.5", "gpt-4.1-2025-04-14" → "GPT-4.1".
export function chatModelLabel(metadata: Record<string, unknown> | null | undefined) {
  if (metadata?.engine === "system") return "Система";
  const model = typeof metadata?.model === "string" ? metadata.model.trim() : "";
  if (!model) return null;
  const fallback = metadata?.fallback === true ? " (запасной)" : "";
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (claude) {
    const family = CLAUDE_FAMILIES[claude[1]] ?? claude[1];
    return `Claude ${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}${fallback}`;
  }
  const gpt = /^gpt-(.+?)(?:-\d{4}-\d{2}-\d{2})?$/.exec(model);
  if (gpt) return `GPT-${gpt[1].replace(/-mini$/, " mini")}${fallback}`;
  return `${model}${fallback}`;
}
