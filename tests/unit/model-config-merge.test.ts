import { describe, expect, it } from "vitest";
import { mergeModelCompat, readModelCompat } from "../../server/model-config-merge.js";
import { ModelConfigDocument, parseModelConfig, patchModelConfig, projectModelConfig, modelConfigSchemas } from "../../server/model-config-document.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configOperations, initialConfigValue, schemaForValue } from "../../web/src/model-config-fields.js";

describe("chat provider editing", () => {
	it("projects only safe compatibility fields including explicit false", () => {
		expect(readModelCompat({ supportsMessageThreads: false, promptCacheKeyMode: "disabled", headers: { Authorization: "secret" }, futureField: "secret", requiresToolsWithToolHistory: "true" })).toEqual({ supportsMessageThreads: false, promptCacheKeyMode: "disabled" });
	});
	it("keeps external-source compatibility inheritance separate from native null values", () => {
		const previous = { futureField: { keep: true }, supportsMessageThreads: true, promptCacheKeyMode: "enabled" };
		expect(mergeModelCompat(previous, { supportsMessageThreads: false, promptCacheKeyMode: null })).toEqual({ futureField: { keep: true }, supportsMessageThreads: false });
		expect(mergeModelCompat(previous, undefined)).toEqual(previous);
		expect(() => mergeModelCompat(previous, { supportsMessageThreads: "false" } as never)).toThrow();
	});
});


describe("native model field patches", () => {
	it("preserves comments, typed rows, credentials and unknown fields when editing leaves", () => {
		const raw = '{\n // keep comment\n "providers": {"fixture": {"apiKey":"secret", "future":{"keep":true}, "models":[{"id":"shared","type":"image"},{"id":"shared","reasoning":true,"samplingParams":{"temperature":0.4},"futureField":"keep"},{"id":"classify","type":"classifier"}]}}\n}';
		const result = patchModelConfig(raw, "fixture", [{ target: { kind: "model", id: "shared" }, operations: [{ op: "set", path: ["reasoning"], value: false }, { op: "set", path: ["samplingParams", "temperature"], value: 0 }, { op: "set", path: ["thinkingLevelMap", "max"], value: null }] }]);
		expect(result).toContain("// keep comment");
		const provider = (JSON.parse(result.replace("// keep comment", ""))).providers.fixture;
		expect(provider.apiKey).toBe("secret");
		expect(provider.future).toEqual({ keep: true });
		expect(provider.models[0]).toEqual({ id: "shared", type: "image" });
		expect(provider.models[1]).toMatchObject({ reasoning: false, samplingParams: { temperature: 0 }, thinkingLevelMap: { max: null }, futureField: "keep" });
		expect(provider.models[2]).toEqual({ id: "classify", type: "classifier" });
	});
	it("distinguishes setting null from removing an override and rejects unknown field writes", () => {
		const raw = JSON.stringify({ providers: { fixture: { models: [{ id: "chat", compat: { supportsMessageThreads: true, futureField: "keep" } }] } } });
		const result = patchModelConfig(raw, "fixture", [{ target: { kind: "model", id: "chat" }, operations: [{ op: "remove", path: ["compat", "supportsMessageThreads"] }] }]);
		expect(JSON.parse(result).providers.fixture.models[0].compat).toEqual({ futureField: "keep" });
		expect(() => patchModelConfig(raw, "fixture", [{ target: { kind: "model", id: "chat" }, operations: [{ op: "set", path: ["compat", "requiresToolsWithToolHistory"], value: "false" }] }])).toThrow();
		expect(() => patchModelConfig(raw, "fixture", [{ target: { kind: "provider" }, operations: [{ op: "set", path: ["unknown"], value: true }] }])).toThrow();
	});
	it("deletes only a selected chat row and writes built-in overrides without copying models", () => {
		const raw = JSON.stringify({ providers: { fixture: { models: [{ id: "shared", type: "image" }, { id: "shared" }] } } });
		const result = patchModelConfig(raw, "fixture", [{ target: { kind: "model", id: "shared" }, remove: true, operations: [] }, { target: { kind: "override", id: "builtin" }, operations: [{ op: "set", path: ["maxTokens"], value: 1000 }] }]);
		expect(JSON.parse(result).providers.fixture).toEqual({ models: [{ id: "shared", type: "image" }], modelOverrides: { builtin: { maxTokens: 1000 } } });
	});
	it("projects schemas without exposing stored secrets", () => {
		const secrets: (string | number)[][] = [];
		const result = projectModelConfig({ apiKey: "secret", headers: { Authorization: "secret-header" }, name: "visible", unknown: "hidden" }, modelConfigSchemas.provider, secrets);
		expect(result).toEqual({ apiKey: null, headers: { Authorization: null }, name: "visible" });
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(secrets).toContainEqual(["headers", "Authorization"]);
	});
	it("rejects stale versions and malformed input without changing disk", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-model-document-"));
		try {
			const path = join(directory, "models.json"), service = new ModelConfigDocument(path);
			writeFileSync(path, '{"providers":{"fixture":{}}}');
			const opened = service.open("fixture");
			writeFileSync(path, '{"providers":{"fixture":{"name":"external"}}}');
			expect(() => service.save("fixture", opened.version, [{ target: { kind: "provider" }, operations: [{ op: "set", path: ["name"], value: "local" }] }])).toThrow("conflict");
			expect(readFileSync(path, "utf8")).toContain("external");
			writeFileSync(path, '{ broken');
			expect(() => service.open("fixture")).toThrow("invalid");
			expect(() => parseModelConfig("{}")).toThrow("invalid");
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});


describe("patch identity and provider metadata", () => {
	it("retains operations and unrelated fields while changing provider metadata", () => {
		const original = { headers: { Authorization: "fixture" }, apiKey: "fixture-key", models: [{ id: "chat", samplingParams: { temperature: 0.1 } }, { id: "picture", type: "image" }, { id: "label", type: "classifier" }], operations: { image: { enabled: true } } };
		const result = JSON.parse(patchModelConfig(JSON.stringify({ providers: { fixture: original } }), "fixture", [{ target: { kind: "provider" }, operations: [{ op: "set", path: ["api"], value: "openai-completions" }] }, { target: { kind: "model", id: "chat" }, operations: [{ op: "set", path: ["name"], value: "Renamed" }, { op: "set", path: ["reasoning"], value: false }] }])).providers.fixture;
		expect(result).toEqual({ ...original, api: "openai-completions", models: [{ ...original.models[0], name: "Renamed", reasoning: false }, ...original.models.slice(1)] });
	});
	it("rejects ambiguous duplicate chat definitions and preserves a no-op document byte for byte", () => {
		const raw = JSON.stringify({ providers: { fixture: { models: [{ id: "a" }, { id: "a" }] } } });
		expect(() => patchModelConfig(raw, "fixture", [{ target: { kind: "model", id: "a" }, operations: [{ op: "set", path: ["name"], value: "Edited" }] }])).toThrow();
		expect(patchModelConfig(raw, "fixture", [])).toBe(raw);
	});
});


describe("model form draft semantics", () => {
	it("uses leaf removals instead of replacing known objects and preserves explicit values", () => {
		expect(configOperations({ compat: { supportsStore: true } }, {})).toEqual([{ op: "remove", path: ["compat", "supportsStore"] }]);
		expect(configOperations({ reasoning: true, samplingParams: { temperature: 1 } }, { reasoning: false, samplingParams: { temperature: 0 }, thinkingLevelMap: { max: null } })).toEqual([{ op: "set", path: ["reasoning"], value: false }, { op: "set", path: ["samplingParams", "temperature"], value: 0 }, { op: "set", path: ["thinkingLevelMap"], value: { max: null } }]);
		expect(initialConfigValue(modelConfigSchemas.model.properties!.cost)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(schemaForValue({ anyOf: [{ type: "string" }, { type: "null" }] }, null)).toEqual({ type: "null" });
	});
});
