import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Return the reasoning paragraph count (the step's softmax logit, not a probability).
 * Only visible thinking content counts; assistant text, tool calls, and opaque
 * thinking signatures do not. Paragraphs are separated by one or more blank
 * lines, including whitespace-only lines. A single line break is a soft wrap.
 * Each thinking block is counted independently as a separate reasoning segment.
 *
 * Valid assistant steps without visible reasoning score zero. Invalid IDs throw
 * so a broken candidate reference is not mistaken for a zero-reasoning step.
 */
export function reasoningScore(
  stepId: string,
  sessionManager: Pick<ExtensionContext["sessionManager"], "getEntry">,
): number {
  const entry = sessionManager.getEntry(stepId);
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") {
    throw new Error(`Reasoning score requires an assistant message entry: ${stepId}`);
  }

  let paragraphs = 0;
  for (const block of entry.message.content) {
    if (block.type !== "thinking" || block.redacted) continue;
    const text = block.thinking.replace(/\r\n?/g, "\n").trim();
    if (!text) continue;
    paragraphs += text.split(/\n[^\S\n]*\n/).filter((paragraph) => paragraph.trim()).length;
  }
  return paragraphs;
}
