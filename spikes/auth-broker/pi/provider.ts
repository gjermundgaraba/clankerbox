// 0.85.1 supports legacy registerProvider; native createProvider examples in
// bundled docs reference exports absent from the published pi-ai package.
export default async function (pi: any) {
  const response = await fetch("http://127.0.0.1:18091/credential");
  if (!response.ok) throw new Error(`broker credential resolution failed: ${response.status}`);
  const { key } = await response.json();
  pi.registerProvider("authprobe", {
    name: "Local auth broker probe",
    baseUrl: "http://127.0.0.1:18091/v1",
    apiKey: key,
    api: "openai-completions",
    models: [{ id: "mock", name: "Mock", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }],
  });
}
