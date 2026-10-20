// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  generate: vi.fn(),
  options: vi.fn(),
  audio: vi.fn(),
}));

vi.mock("./generation.functions", () => ({ generateSetContent: deps.generate }));
vi.mock("./meaning.functions", () => ({ getMeaningQuestion: deps.options }));
// Any accidental return to eager TTS will fail; this never supplies mock audio.
vi.mock("./audio.functions", () => ({ prepareAudio: deps.audio }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      let action = "select";
      let values: Record<string, unknown> | Record<string, unknown>[] = {};
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      const execute = () => {
        const rows = deps.tables[table] ?? [];
        const matches = rows.filter((r) => filters.every((f) => f(r)));
        if (action === "delete") deps.tables[table] = rows.filter((r) => !matches.includes(r));
        if (action === "update") matches.forEach((r) => Object.assign(r, values));
        if (action === "insert") {
          const inserted = (Array.isArray(values) ? values : [values]).map((r, i) => ({ id: `${table}-${rows.length + i}`, ...r }));
          deps.tables[table] = [...rows, ...inserted];
          return { data: inserted, error: null };
        }
        return { data: matches, error: null };
      };
      const query = {
        select: (_columns?: string) => query,
        eq: (key: string, value: unknown) => { filters.push((r) => r[key] === value); return query; },
        is: (key: string, value: unknown) => { filters.push((r) => (r[key] ?? null) === value); return query; },
        not: (key: string, _operator: string, _value: string) => { filters.push((r) => !String(r[key]).startsWith("form:")); return query; },
        order: (_key: string) => query,
        insert: (input: Record<string, unknown>[]) => { action = "insert"; values = input; return query; },
        update: (input: Record<string, unknown>) => { action = "update"; values = input; return query; },
        delete: () => { action = "delete"; return query; },
        single: async () => ({ ...execute(), data: execute().data[0] }),
        maybeSingle: async () => ({ ...execute(), data: execute().data[0] ?? null }),
        then: (resolve: (value: ReturnType<typeof execute>) => unknown) => Promise.resolve(execute()).then(resolve),
      };
      return query;
    },
  },
}));

import { prepareSet, setReadiness } from "./analysis";

beforeEach(() => {
  vi.clearAllMocks();
  deps.tables = {
    word_sets: [{ id: "set", target_language: "en", native_language: "ar" }],
    words: [{ id: "word", set_id: "set", text: "apple", translation: null, analysis_status: "pending", meaning_options: null }],
    word_forms: [], sentences: [], learning_items: [],
  };
  deps.audio.mockRejectedValue(new Error("tts-429"));
  deps.generate.mockResolvedValue([{
    target_word: "apple", translation: "تفاحة", part_of_speech: "noun",
    sentences: [{ text: "I eat an apple.", translation: "آكل تفاحة.", form: "base", variation_index: 0 }],
  }]);
  deps.options.mockResolvedValue({ distractors: [{ text: "كتاب" }, { text: "باب" }, { text: "قلم" }] });
});

describe("audio-independent saved learning content", () => {
  it("marks text and exercises ready without requesting unavailable TTS", async () => {
    await prepareSet("user", "set");
    expect(deps.audio).not.toHaveBeenCalled();
    expect(deps.tables.words[0]).toMatchObject({ translation: "تفاحة", analysis_status: "ready", analysis_error: null });
    expect(deps.tables.sentences).toHaveLength(1);
    expect(deps.tables.learning_items.map((r) => r.skill)).toEqual(["recognition", "writing", "speaking", "recall"]);
    expect((await setReadiness("set", "words")).ready).toBe(true);
  });

  it("keeps real text generation failure retryable rather than declaring success", async () => {
    deps.generate.mockRejectedValueOnce(new Error("generation-429"));
    await prepareSet("user", "set");
    expect(deps.tables.words[0]).toMatchObject({ analysis_status: "failed", analysis_error: "generation-429" });
    expect((await setReadiness("set", "words")).ready).toBe(false);
  });

  it("retries missing options without duplicating saved sentences or exercises", async () => {
    deps.options.mockRejectedValueOnce(new Error("options-429"));
    await prepareSet("user", "set");
    expect(deps.tables.words[0].analysis_status).toBe("failed");
    await prepareSet("user", "set");
    await prepareSet("user", "set");
    expect(deps.generate).toHaveBeenCalledTimes(1);
    expect(deps.options).toHaveBeenCalledTimes(2);
    expect(deps.tables.words[0].analysis_status).toBe("ready");
    expect(deps.tables.sentences).toHaveLength(1);
    expect(deps.tables.learning_items).toHaveLength(4);
  });

  it("prepares form options independently of unavailable audio", async () => {
    deps.tables.words = [];
    deps.tables.word_forms = [{ id: "form", set_id: "set", text: "apples", translation: "تفاحات", example: "Two apples.", meaning_options: null }];
    await prepareSet("user", "set");
    expect(deps.audio).not.toHaveBeenCalled();
    expect(deps.tables.word_forms[0].meaning_options).toEqual(["كتاب", "باب", "قلم"]);
    expect((await setReadiness("set", "forms")).ready).toBe(true);
  });
});