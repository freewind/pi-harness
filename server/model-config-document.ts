import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from "jsonc-parser";
import { Compile } from "typebox/compile";
import type { ModelConfigSchema, ModelConfigTarget, ModelConfigChange, ModelConfigValue } from "./protocol.js";
import { writeFileAtomic } from "./private-file.js";

const sdkModulePath = createRequire(import.meta.url).resolve.paths("@earendil-works/pi-coding-agent")?.map(directory => join(directory, "@earendil-works/pi-coding-agent/dist/core/model-config.js")).find(path => existsSync(path));
if (!sdkModulePath) throw new Error("Pi model configuration schema missing");
const sdkModule = await import(pathToFileURL(sdkModulePath).href) as {
	ModelsJsonSchemas: { provider: ModelConfigSchema; model: ModelConfigSchema; modelOverride: ModelConfigSchema };
};
export const modelConfigSchemas = {
	provider: sdkModule.ModelsJsonSchemas.provider,
	model: sdkModule.ModelsJsonSchemas.model,
	override: sdkModule.ModelsJsonSchemas.modelOverride,
};
const aiModulePath = createRequire(import.meta.url).resolve.paths("@earendil-works/pi-ai")?.map(directory => join(directory, "@earendil-works/pi-ai/dist/providers/compat-schema.js")).find(path => existsSync(path));
if (!aiModulePath) throw new Error("Pi API compatibility schema missing");
export const { CompatSchemasByApi: modelCompatSchemas } = await import(pathToFileURL(aiModulePath).href) as { CompatSchemasByApi: Record<string, ModelConfigSchema> };
const validators = Object.fromEntries(Object.entries(modelConfigSchemas).map(([key, schema]) => [key, Compile(schema as never)]));
export const configRecord = (value: unknown): Record<string, ModelConfigValue> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, ModelConfigValue> : {};
const modelDocumentVersions = new Map<string, Map<string, { raw: string; providerId: string }>>();
const chat = (value: unknown) => { const row = configRecord(value); return row.type === undefined || row.type === "chat"; };
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export class ModelConfigDocumentError extends Error {
	constructor(readonly code: "invalid" | "conflict" | "unreadable", readonly field?: string) { super(code); }
}

export function parseModelConfig(raw: string): Record<string, ModelConfigValue> {
	const errors: ParseError[] = [];
	const document = parse(raw.replace(/^\uFEFF/, " "), errors, { allowTrailingComma: true, disallowComments: false });
	if (errors.length || !document || Array.isArray(document) || typeof document !== "object" || !document.providers || Array.isArray(document.providers) || typeof document.providers !== "object") throw new ModelConfigDocumentError("invalid");
	return document;
}

export function schemaChild(schema: ModelConfigSchema, key: string | number): ModelConfigSchema | undefined {
	if (typeof key === "number") return schema.items;
	if (forbidden.has(key)) return undefined;
	if (schema.properties?.[key]) return schema.properties[key];
	const pattern = Object.entries(schema.patternProperties ?? {}).find(([pattern]) => new RegExp(pattern).test(key));
	if (pattern) return pattern[1];
	if (schema.anyOf) return schema.anyOf.map(branch => schemaChild(branch, key)).find(Boolean);
	if (!schema.type && !schema.anyOf || schema.additionalProperties === true && !schema.properties) return {};
	if (typeof schema.additionalProperties === "object") return schema.additionalProperties;
	return undefined;
}

/** Only schema-owned fields leave the server. Existing credentials are represented by paths, not masks. */
export function projectModelConfig(value: ModelConfigValue, schema: ModelConfigSchema, secrets: (string | number)[][] = [], path: (string | number)[] = []): ModelConfigValue {
	if (path.at(-1) === "apiKey" || path.includes("headers") && typeof value === "string") { secrets.push(path); return null; }
	if (typeof value === "string" && path.at(-1) === "baseUrl") {
		try { const url = new URL(value); if (url.search || url.username || url.password) { secrets.push(path); url.search = ""; url.username = ""; url.password = ""; return url.href; } } catch { /* Native variable references are displayed without resolving them. */ }
	}
	if (Array.isArray(value)) return value.map((item, index) => projectModelConfig(item, schema.items ?? {}, secrets, [...path, index]));
	if (value && typeof value === "object") {
		const result: Record<string, ModelConfigValue> = {};
		for (const [key, item] of Object.entries(value)) {
			if (["models", "modelOverrides"].includes(key) && path.length === 0) continue;
			const child = schemaChild(schema, key);
			if (!child) continue;
			if (/^(authorization|api[_-]?key|access[_-]?token|token|password|secret)$/i.test(key)) { secrets.push([...path, key]); result[key] = null; }
			else result[key] = projectModelConfig(item, child, secrets, [...path, key]);
		}
		return result;
	}
	return value;
}

export function modelTargetPath(provider: Record<string, ModelConfigValue>, providerId: string, target: ModelConfigTarget): (string | number)[] {
	const root: (string | number)[] = ["providers", providerId];
	if (target.kind === "provider") return root;
	if (!target.id || forbidden.has(target.id)) throw new ModelConfigDocumentError("invalid", "id");
	if (target.kind === "override") return [...root, "modelOverrides", target.id];
	const rows = Array.isArray(provider.models) ? provider.models : [];
	const matches = rows.map((row, index) => ({ row: configRecord(row), index })).filter(({ row }) => row.id === target.id && chat(row));
	if (matches.length > 1) throw new ModelConfigDocumentError("invalid", "models.id");
	return [...root, "models", matches[0]?.index ?? rows.length];
}

function removeConfigValue(raw: string, path: (string | number)[]): string {
	const tree = parseTree(raw.replace(/^\uFEFF/, " "));
	const value = tree && findNodeAtLocation(tree, path);
	if (!value) return raw;
	const node = value.parent?.type === "property" ? value.parent : value;
	const siblings = node.parent?.children ?? [];
	const index = siblings.indexOf(node);
	const previous = siblings[index - 1], next = siblings[index + 1];
	const start = previous ? previous.offset + previous.length : node.offset;
	const end = previous || !next ? node.offset + node.length : next.offset;
	return raw.slice(0, start) + raw.slice(end);
}

/** The same path contract validates both UI writes and unknown-field preservation tests. */
export function patchModelConfig(raw: string, providerId: string, changes: ModelConfigChange[]): string {
	if (!/^[\w.-]+$/.test(providerId) || forbidden.has(providerId)) throw new ModelConfigDocumentError("invalid", "providerId");
	let next = raw;
	for (const change of changes) {
		if (!change.remove && !change.operations.length) continue;
		if (!["provider", "model", "override"].includes(change.target.kind)) throw new ModelConfigDocumentError("invalid");
		const document = parseModelConfig(next), provider = configRecord(configRecord(document.providers)[providerId]);
		const root = modelTargetPath(provider, providerId, change.target);
		const rows = Array.isArray(provider.models) ? provider.models : [];
		const existing = change.target.kind === "provider" ? provider : change.target.kind === "override" ? configRecord(provider.modelOverrides)[change.target.id!] : rows[root.at(-1) as number];
		if (change.target.kind === "override" && change.operations.length && change.operations.every(operation => operation.op === "remove") && existing === undefined) continue;
		if (change.remove) {
			if (change.target.kind === "provider") throw new ModelConfigDocumentError("invalid");
			if (existing === undefined) continue;
			next = removeConfigValue(next, root);
			continue;
		}
		if (!existing && change.target.kind === "model") next = applyEdits(next, modify(next, root, { id: change.target.id }, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
		for (const operation of change.operations) {
			let schema = modelConfigSchemas[change.target.kind];
			if (operation.op !== "set" && operation.op !== "remove" || !Array.isArray(operation.path) || operation.path.some(key => typeof key !== "string" && (!Number.isSafeInteger(key) || key < 0))) throw new ModelConfigDocumentError("invalid");
			if (!operation.path.length || change.target.kind === "provider" && ["models", "modelOverrides"].includes(String(operation.path[0])) || change.target.kind === "model" && operation.path[0] === "id") throw new ModelConfigDocumentError("invalid", operation.path.join("."));
			for (const key of operation.path) { const child = schemaChild(schema, key); if (!child) throw new ModelConfigDocumentError("invalid", operation.path.join(".")); schema = child; }
			if (operation.op === "remove" && (schema.properties || schema.patternProperties || schema.items) || operation.op === "set" && operation.value && typeof operation.value === "object") {
				const currentDocument = parseModelConfig(next);
				let current: ModelConfigValue | undefined = currentDocument;
				for (const key of [...root, ...operation.path]) current = current && typeof current === "object" ? (current as Record<string | number, ModelConfigValue>)[key] : undefined;
				const unknown = (value: ModelConfigValue | undefined, shape: ModelConfigSchema): boolean => {
					if (Array.isArray(value)) return value.some(item => unknown(item, shape.items ?? {}));
					return !!value && typeof value === "object" && Object.entries(value).some(([key, item]) => { const child = schemaChild(shape, key); return !child || unknown(item, child); });
				};
				const maskedPaths: (string | number)[][] = [];
				if (current !== undefined) projectModelConfig(current, schema, maskedPaths, operation.path);
				if (unknown(current, schema) || maskedPaths.length > 0) throw new ModelConfigDocumentError("invalid", operation.path.join("."));
			}
			if (operation.op === "set" && !Compile(schema as never).Check(operation.value)) throw new ModelConfigDocumentError("invalid", operation.path.join("."));
			const absolutePath = [...root, ...operation.path];
			next = operation.op === "remove" ? removeConfigValue(next, absolutePath) : applyEdits(next, modify(next, absolutePath, operation.value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
			if (operation.op === "remove") for (let depth = absolutePath.length - 1; depth > root.length; depth--) {
				const parentPath = absolutePath.slice(0, depth), tree = parseTree(next.replace(/^\uFEFF/, " "));
				const parent = tree && findNodeAtLocation(tree, parentPath);
				if (parent?.type !== "object" || parent.children?.length) break;
				next = removeConfigValue(next, parentPath);
			}
		}
		const updated = parseModelConfig(next);
		let target: ModelConfigValue | undefined = updated;
		for (const key of root) target = target && typeof target === "object" ? (target as Record<string | number, ModelConfigValue>)[key] : undefined;
		const validationValue = change.target.kind === "provider" ? Object.fromEntries(Object.entries(configRecord(target)).filter(([key]) => key !== "models" && key !== "modelOverrides")) : target;
		const validator = validators[change.target.kind];
		if (!validator.Check(validationValue)) {
			const previousValue = change.target.kind === "provider" ? Object.fromEntries(Object.entries(configRecord(existing)).filter(([key]) => key !== "models" && key !== "modelOverrides")) : existing;
			const previousErrors = existing ? new Set(validator.Errors(previousValue).map((error: { instancePath: string; keyword: string }) => `${error.instancePath}:${error.keyword}`)) : new Set<string>();
			const introduced = validator.Errors(validationValue).find((error: { instancePath: string; keyword: string }) => !previousErrors.has(`${error.instancePath}:${error.keyword}`));
			if (introduced) throw new ModelConfigDocumentError("invalid", introduced.instancePath || change.target.kind);
		}
	}
	return next;
}

export class ModelConfigDocument {
	private readonly versions: Map<string, { raw: string; providerId: string }>;
	constructor(readonly path: string) {
		let versions = modelDocumentVersions.get(path);
		if (!versions) { versions = new Map(); modelDocumentVersions.set(path, versions); }
		this.versions = versions;
	}
	read(): string {
		try { return readFileSync(this.path, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return '{\n  "providers": {}\n}\n'; throw new ModelConfigDocumentError("unreadable"); }
	}
	open(providerId: string) {
		const raw = this.read(), document = parseModelConfig(raw), version = randomUUID();
		this.versions.set(version, { raw, providerId });
		if (this.versions.size > 100) this.versions.delete(this.versions.keys().next().value!);
		return { raw, document, version, exists: existsSync(this.path) };
	}
	save(providerId: string, version: string, changes: ModelConfigChange[]) {
		const base = this.versions.get(version), raw = this.read();
		if (!base || base.providerId !== providerId && base.providerId !== "" || base.raw !== raw || base.providerId === "" && Object.hasOwn(configRecord(parseModelConfig(raw).providers), providerId)) throw new ModelConfigDocumentError("conflict");
		if (!Array.isArray(changes)) throw new ModelConfigDocumentError("invalid");
		const next = patchModelConfig(raw, providerId, changes);
		if (next !== raw) writeFileAtomic(this.path, next, { keepExistingMode: true });
		this.versions.delete(version);
		return next !== raw;
	}
	deleteProvider(providerId: string) {
		const raw = this.read();
		const parsed = parseModelConfig(raw);
		if (!Object.hasOwn(configRecord(parsed.providers), providerId)) return false;
		const next = removeConfigValue(raw, ["providers", providerId]);
		writeFileAtomic(this.path, next, { keepExistingMode: true });
		return true;
	}
}
