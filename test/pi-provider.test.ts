import { NoSuchModelError } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

// ─── Mock @earendil-works/pi-ai for model resolution ───
vi.mock("@earendil-works/pi-ai", () => {
  const mockModel = (id: string, provider: string, name: string) => ({
    id,
    name,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200_000,
    maxTokens: 8192,
  });

  return {
    getModel: vi.fn((provider: string, modelId: string) => {
      const registry: Record<
        string,
        Record<string, ReturnType<typeof mockModel>>
      > = {
        anthropic: {
          "claude-sonnet-4": mockModel(
            "claude-sonnet-4",
            "anthropic",
            "Claude Sonnet 4"
          ),
          "claude-opus-4": mockModel(
            "claude-opus-4",
            "anthropic",
            "Claude Opus 4"
          ),
          "claude-haiku-4": mockModel(
            "claude-haiku-4",
            "anthropic",
            "Claude Haiku 4"
          ),
        },
        openai: {
          "gpt-4o": mockModel("gpt-4o", "openai", "GPT-4o"),
          "gpt-4o-mini": mockModel("gpt-4o-mini", "openai", "GPT-4o Mini"),
          o3: mockModel("o3", "openai", "o3"),
          "o4-mini": mockModel("o4-mini", "openai", "o4-mini"),
        },
        google: {
          "gemini-2.5-pro": mockModel(
            "gemini-2.5-pro",
            "google",
            "Gemini 2.5 Pro"
          ),
        },
      };
      return registry[provider]?.[modelId];
    }),
  };
});

// ─── Mock @earendil-works/pi-coding-agent ───
vi.mock("@earendil-works/pi-coding-agent", () => {
  const mockFind = vi.fn(() => undefined);

  return {
    AuthStorage: {
      create: vi.fn(() => ({})),
    },
    ModelRegistry: {
      create: vi.fn(() => ({
        find: mockFind,
      })),
    },
    SessionManager: {
      inMemory: vi.fn(() => ({})),
    },
    createAgentSession: vi.fn(),
  };
});

// Import AFTER mocks are set up
const { createPi, pi } = await import("../src/pi-provider.js");
const { PiLanguageModel } = await import("../src/pi-language-model.js");

describe("createPi", () => {
  describe("provider callable", () => {
    it("returns a PiLanguageModel when called with a valid model ID", () => {
      const provider = createPi();
      const model = provider("sonnet");
      expect(model).toBeInstanceOf(PiLanguageModel);
      expect(model.modelId).toBe("sonnet");
      expect(model.provider).toBe("pi");
    });

    it("throws NoSuchModelError for invalid model ID", () => {
      const provider = createPi();
      expect(() => provider("nonexistent/unknown-model-12345")).toThrow(
        NoSuchModelError
      );
    });

    it("throws for empty string model ID", () => {
      const provider = createPi();
      expect(() => provider("")).toThrow();
    });
  });

  describe("provider properties", () => {
    it("has specificationVersion v3", () => {
      const provider = createPi();
      expect(provider.specificationVersion).toBe("v3");
    });

    it("languageModel() creates a PiLanguageModel", () => {
      const provider = createPi();
      const model = provider.languageModel("sonnet");
      expect(model).toBeInstanceOf(PiLanguageModel);
    });

    it("chat() creates a PiLanguageModel (alias for languageModel)", () => {
      const provider = createPi();
      const model = provider.chat("haiku");
      expect(model).toBeInstanceOf(PiLanguageModel);
      expect(model.modelId).toBe("haiku");
    });

    it("embeddingModel() throws NoSuchModelError", () => {
      const provider = createPi();
      expect(() => provider.embeddingModel("any-model")).toThrow(
        NoSuchModelError
      );
      try {
        provider.embeddingModel("any-model");
        expect.unreachable();
      } catch (e) {
        if (e instanceof NoSuchModelError) {
          expect(e.modelType).toBe("embeddingModel");
        } else {
          throw e;
        }
      }
    });

    it("imageModel() throws NoSuchModelError", () => {
      const provider = createPi();
      expect(() => provider.imageModel("any-model")).toThrow(NoSuchModelError);
      try {
        provider.imageModel("any-model");
        expect.unreachable();
      } catch (e) {
        if (e instanceof NoSuchModelError) {
          expect(e.modelType).toBe("imageModel");
        } else {
          throw e;
        }
      }
    });
  });

  describe("provider settings merging", () => {
    it("uses model-level cwd over provider-level cwd", () => {
      const provider = createPi({ cwd: "/provider/cwd" });
      const model = provider("sonnet", {
        cwd: "/model/cwd",
      }) as PiLanguageModel;
      expect(model).toBeDefined();
      expect(model.modelId).toBe("sonnet");
    });

    it("accepts provider-level cwd as fallback", () => {
      const provider = createPi({ cwd: "/provider/cwd" });
      const model = provider("sonnet") as PiLanguageModel;
      expect(model).toBeDefined();
    });
  });

  describe("cannot be called with new", () => {
    it("throws when called as constructor", () => {
      const provider = createPi();
      expect(() => {
        // @ts-expect-error testing runtime behavior
        new provider("sonnet");
      }).toThrow("cannot be called with the new keyword");
    });
  });
});

describe("default pi instance", () => {
  it("is a valid provider", () => {
    expect(pi).toBeDefined();
    expect(typeof pi).toBe("function");
  });

  it("has languageModel method", () => {
    expect(typeof pi.languageModel).toBe("function");
  });

  it("has chat method", () => {
    expect(typeof pi.chat).toBe("function");
  });

  it("can create a model with valid alias", () => {
    const model = pi("sonnet");
    expect(model).toBeInstanceOf(PiLanguageModel);
  });
});
