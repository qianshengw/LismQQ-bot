// apiKeyAuth 辅助：构造 pi-ai 的 ApiKeyAuth（固定 key，无交互）。
export function apiKeyAuth(name) {
  return {
    name,
    resolve: async ({ credential }) => {
      if (credential?.key) return { auth: { apiKey: credential.key }, source: 'credential' };
      return undefined;
    },
  };
}
