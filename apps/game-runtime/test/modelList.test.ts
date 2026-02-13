import { describe, expect, it } from "vitest";
import { parseModelListResponse } from "../src/runtime/modelList";

describe("modelList parser", () => {
  it("parses model/list result.data with reasoning efforts", () => {
    const parsed = parseModelListResponse({
      result: {
        data: [
          {
            id: "gpt-5",
            model: "gpt-5",
            displayName: "GPT-5",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "Deep" }
            ],
            defaultReasoningEffort: "medium",
            isDefault: true
          }
        ]
      }
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "gpt-5",
      model: "gpt-5",
      defaultReasoningEffort: "medium",
      isDefault: true
    });
    expect(parsed[0]?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort)).toEqual([
      "low",
      "high"
    ]);
  });

  it("parses snake_case shape", () => {
    const parsed = parseModelListResponse({
      data: [
        {
          id: "gpt-5-mini",
          model: "gpt-5-mini",
          display_name: "GPT-5 Mini",
          supported_reasoning_efforts: [{ reasoning_effort: "low", description: "Fast" }],
          default_reasoning_effort: "low"
        }
      ]
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.displayName).toBe("GPT-5 Mini");
    expect(parsed[0]?.supportedReasoningEfforts[0]?.reasoningEffort).toBe("low");
  });
});

