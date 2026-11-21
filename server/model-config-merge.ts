import type { UiModelCompat } from "./protocol.js";

const booleanCompatKeys = ["supportsMessageThreads", "requiresNonNullAssistantContent", "requiresToolsWithToolHistory"] as const;
const compatKeys = [...booleanCompatKeys, "promptCacheKeyMode"] as const;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validCompatValue = (key: typeof compatKeys[number], value: unknown) => key === "promptCacheKeyMode"
	? value === "auto" || value === "enabled" || value === "disabled" : typeof value === "boolean";

/** Only documented non-secret fields cross the wire, including explicit false. */
export function readModelCompat(value: unknown): { [K in keyof UiModelCompat]?: NonNullable<UiModelCompat[K]> } | undefined {
	const raw = object(value);
	const entries = compatKeys.filter(key => validCompatValue(key, raw[key])).map(key => [key, raw[key]]);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

/** A patch owns only the whitelist. Unknown native fields remain server-side. */
export function mergeModelCompat(previous: unknown, patch: UiModelCompat | undefined): Record<string, unknown> | undefined {
	if (patch === undefined) return previous as Record<string, unknown> | undefined;
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid model compatibility settings");
	const result = { ...object(previous) };
	for (const key of compatKeys) {
		if (!Object.hasOwn(patch, key) || patch[key] === undefined) continue;
		const value = patch[key];
		if (value === null) delete result[key];
		else if (validCompatValue(key, value)) result[key] = value;
		else throw new Error(`Invalid compatibility setting: ${key}`);
	}
	return Object.keys(result).length ? result : undefined;
}


export const isChatModelConfig = (model: Record<string, unknown>): boolean => model.type === undefined || model.type === "chat";
