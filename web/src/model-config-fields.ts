import type { ModelConfigChange, ModelConfigOperation, ModelConfigSchema, ModelConfigValue } from "../../server/protocol.js";

export const modelFieldGroups = [
	{ key: "basic", fields: ["id", "name", "api", "baseUrl", "apiKey", "oauth", "authHeader"] },
	{ key: "capabilities", fields: ["reasoning", "input", "contextWindow", "maxTokens"] },
	{ key: "thinking", fields: ["thinkingLevelMap"] },
	{ key: "sampling", fields: ["samplingParams", "samplingParamsByThinkingLevel"] },
	{ key: "pricing", fields: ["cost"] },
	{ key: "inputLimits", fields: ["inputLimits"] },
	{ key: "cache", fields: ["promptCache"] },
	{ key: "compatibility", fields: ["compat"] },
	{ key: "headers", fields: ["headers"] },
] as const;

export function valueKind(value: ModelConfigValue | undefined): string {
	return value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
}
export function schemaForValue(schema: ModelConfigSchema, value: ModelConfigValue | undefined): ModelConfigSchema {
	return schema.anyOf?.find(branch => branch.type === valueKind(value) || Object.hasOwn(branch, "const") && branch.const === value) ?? schema.anyOf?.find(branch => branch.type !== "null") ?? schema;
}
export function initialConfigValue(schema: ModelConfigSchema): ModelConfigValue {
	const resolved = schemaForValue(schema, undefined);
	if (Object.hasOwn(resolved, "const")) return resolved.const!;
	if (resolved.type === "object" || resolved.properties || resolved.patternProperties) return Object.fromEntries((resolved.required ?? []).map(key => [key, initialConfigValue(resolved.properties?.[key] ?? {})]));
	if (resolved.type === "array") return [];
	if (resolved.type === "number" || resolved.type === "integer") return resolved.minimum ?? (resolved.exclusiveMinimum !== undefined ? resolved.exclusiveMinimum + 1 : 0);
	if (resolved.type === "boolean") return false;
	if (resolved.type === "null") return null;
	return "";
}

/** Diff objects by leaf; arrays are one atomic value because indices move on deletion. */
export function configOperations(previous: Record<string, ModelConfigValue>, next: Record<string, ModelConfigValue>, path: (string | number)[] = []): ModelConfigOperation[] {
	const operations: ModelConfigOperation[] = [];
	for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
		const before = previous[key], after = next[key], child = [...path, key];
		if (JSON.stringify(before) === JSON.stringify(after)) continue;
		if (after === undefined && before && typeof before === "object" && !Array.isArray(before)) operations.push(...configOperations(before, {}, child));
		else if (after === undefined) operations.push({ op: "remove", path: child });
		else if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) operations.push(...configOperations(before, after, child));
		else operations.push({ op: "set", path: child, value: after });
	}
	return operations;
}
export function compactConfigChanges(changes: ModelConfigChange[]) { return changes.filter(change => change.remove || change.operations.length); }
