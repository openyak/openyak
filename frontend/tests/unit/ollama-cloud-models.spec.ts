import { expect, test } from "@playwright/test";
import {
  getOllamaCloudModelMessage,
  isOllamaCloudModelTag,
} from "../../src/lib/ollama-cloud-models";

test.describe("Ollama cloud model boundary", () => {
  test("recognizes explicit cloud tags across supported naming forms", () => {
    expect(isOllamaCloudModelTag("glm-5.1:cloud")).toBe(true);
    expect(isOllamaCloudModelTag("org/glm-5.1:CLOUD")).toBe(true);
    expect(isOllamaCloudModelTag(" gpt-oss:120b-cloud ")).toBe(true);
  });

  test("does not classify local models by a cloud-like model name", () => {
    expect(isOllamaCloudModelTag("cloudburst:7b")).toBe(false);
    expect(isOllamaCloudModelTag("glm-5.1")).toBe(false);
    expect(isOllamaCloudModelTag("cloud")).toBe(false);
  });

  test("gives an actionable manual path and supported alternatives", () => {
    const message = getOllamaCloudModelMessage(" glm-5.1:cloud ");

    expect(message).toContain("ollama signin");
    expect(message).toContain("ollama run glm-5.1:cloud");
    expect(message).toContain("local tag");
    expect(message).toContain("ChatGPT / OpenRouter");
  });
});
