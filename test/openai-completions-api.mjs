// openai-completions API 流实现（对齐 pi-ai ProviderStreams 形状，仅够联调用）。
// 直接复用 pi-ai 包内部的 openai-completions 实现（streamSimple 是它的具名导出）。
export async function openAICompletionsApi() {
  const impl = await import('@earendil-works/pi-ai/api/openai-completions');
  return { stream: impl.stream, streamSimple: impl.streamSimple };
}
