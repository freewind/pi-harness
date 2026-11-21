import type { ModelSourceSync } from "./model-source-sync.js";
import { ModelConfigDocument, ModelConfigDocumentError, configRecord, modelConfigSchemas, modelCompatSchemas, parseModelConfig, projectModelConfig } from "./model-config-document.js";
import type { ModelConfigChange, ModelConfigEditorSnapshot, ModelConfigValue } from "./protocol.js";
import { isSelectableProvider } from "./provider-catalog.js";
import { updateAuthFile } from "./auth-file.js";
import { isChatModelConfig, readModelCompat } from "./model-config-merge.js";
/**
 * model-admin — 模型/服务商配置管理，从 agent-service.ts 抽出。
 *
 * 职责：auth.json 的 provider api-key 存取（set/clear）、models.json 读写
 * （listModelsConfig/saveModelConfig/deleteModelConfig）、自定义服务商「自动获取
 * 模型列表」（fetch_models：服务端探测 OpenAI 兼容 /models 端点，绕开 CORS；
 * anthropic/google 鉴权头各不同；裸 /models 404 回退 /v1/models）与已保存供应商
 * 的一键刷新（refresh_provider_models，凭据不出浏览器）。改动后热更新 runtime
 * （refresh/setRuntimeApiKey）并推 models/models_config。
 *
 * 经 ModelAdminHost 与 ClientSession 解耦（同 settings/goal/slash 服务模式）。
 * UI 文案直接中文（服务端 notice 约定）。apiKey/headers 绝不下发浏览器。
 */
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig } from "./protocol.js";

/** ClientSession 提供给本服务的宿主能力（窄接口）。 */
export interface ModelAdminHost {
	agentDir: string;
	sources?: () => ModelSourceSync | undefined;
	emit: (msg: ServerMessage) => void;
	flushSnapshot: () => void;
	isDisposed: () => boolean;
	/** 共享 ModelRuntime（所有对话共用），改动后需 refresh/热更新。 */
	modelRuntime: () => ModelRuntime;
	/** auth/models 变更后 pi 配置检测缓存失效（piConfigured 可能翻转）。 */
	invalidatePiConfig: () => void;
	/** 变更后重推顶栏模型下拉。 */
	pushModels: () => Promise<void>;
}


/** Numeric metadata value (NaN/string "unknown" → undefined). */
function numMeta(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolMeta(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function strArrMeta(v: unknown): string[] | undefined {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string")
		: undefined;
}

/** Best-effort extraction of model metadata from an OpenAI-compatible
 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
 *  fields (context_window / max_model_len / modalities / supports_vision /
 *  reasoning / display_name) come from vLLM and other extended
 *  implementations, and are filled into the form when present. */
function parseOpenAiModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const id = typeof r.id === "string" ? r.id : "";
	const name =
		(typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
		(typeof r.display_name === "string" && r.display_name.trim()
			? r.display_name
			: undefined);
	const modalities =
		strArrMeta(r.modalities) ??
		strArrMeta(r.input_modalities);
	const vision =
		modalities?.includes("image") === true ||
		boolMeta(r.supports_vision) === true ||
		boolMeta(r.vision) === true ||
		strArrMeta(r.input)?.includes("image") === true;
	const reasoning =
		boolMeta(r.reasoning) === true ||
		boolMeta(r.supports_reasoning) === true ||
		modalities?.includes("reasoning") === true;
	const contextWindow =
		numMeta(r.context_window) ??
		numMeta(r.context_length) ??
		numMeta(r.max_model_len) ??
		numMeta(r.max_context_length);
	const maxTokens =
		numMeta(r.max_tokens) ??
		numMeta(r.max_output_tokens) ??
		numMeta(r.max_completion_tokens);
	return {
		id,
		...(name ? { name } : {}),
		...(reasoning ? { reasoning: true } : {}),
		...(vision ? { input: ["text", "image"] } : {}),
		...(contextWindow ? { contextWindow } : {}),
		...(maxTokens ? { maxTokens } : {}),
	};
}

/** google-generative-ai /models shape:
 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
 *               outputTokenLimit, supportedGenerationMethods }] } */
function parseGoogleModel(m: unknown): UiModelConfigEntry {
	const r = (m ?? {}) as Record<string, unknown>;
	const rawName = typeof r.name === "string" ? r.name : "";
	const id = rawName.replace(/^models\//, "");
	const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
	return {
		id,
		...(displayName && displayName !== id ? { name: displayName } : {}),
		...(numMeta(r.inputTokenLimit)
			? { contextWindow: numMeta(r.inputTokenLimit) }
			: {}),
		...(numMeta(r.outputTokenLimit)
			? { maxTokens: numMeta(r.outputTokenLimit) }
			: {}),
	};
}


export class ModelAdminService {
	private readonly document: ModelConfigDocument;
	private pendingEditors = new Map<string, { reqId: number; version: string }>();
	constructor(private readonly host: ModelAdminHost) { this.document = new ModelConfigDocument(join(host.agentDir, "models.json")); }

	private editorSnapshot(providerId: string): ModelConfigEditorSnapshot {
		if (providerId !== "" && !/^[\w.-]+$/.test(providerId) || this.host.sources?.()?.owns(providerId)) throw new ModelConfigDocumentError("invalid");
		const { document, version } = this.document.open(providerId);
		const original = configRecord(configRecord(document.providers)[providerId]);
		const secretPaths: (string | number)[][] = [];
		const provider = configRecord(projectModelConfig(original, modelConfigSchemas.provider, secretPaths));
		const models: ModelConfigEditorSnapshot["models"] = [];
		const explicit = new Set<string>();
		for (const value of Array.isArray(original.models) ? original.models : []) {
			const model = configRecord(value);
			if (!isChatModelConfig(model) || typeof model.id !== "string") continue;
			const secrets: (string | number)[][] = [];
			models.push({ target: { kind: "model", id: model.id }, value: configRecord(projectModelConfig(model, modelConfigSchemas.model, secrets)), secretPaths: secrets });
			explicit.add(model.id);
		}
		const overrides = configRecord(original.modelOverrides);
		const runtime = this.host.modelRuntime();
		const catalog = new Map((providerId ? runtime.getModels(providerId) : []).map(model => [model.id, model]));
		for (const id of new Set([...Object.keys(overrides), ...catalog.keys()])) {
			if (explicit.has(id) && !Object.hasOwn(overrides, id)) continue;
			const secrets: (string | number)[][] = [];
			models.push({ target: { kind: "override", id }, value: configRecord(projectModelConfig(overrides[id] ?? {}, modelConfigSchemas.override, secrets)), secretPaths: secrets });
		}
		for (const row of models) {
			const effective = catalog.get(row.target.id!);
			if (effective) row.effective = { name: effective.name, api: effective.api, contextWindow: effective.contextWindow, maxTokens: effective.maxTokens };
		}
		return { providerId, version, path: this.document.path, provider, secretPaths, models, schemas: modelConfigSchemas, compatSchemas: modelCompatSchemas,
			outputOverride: process.env.PI_MAX_TOKENS ?? (process.env.PI_MAX_TOKENS_FLOOR !== undefined ? `PI_MAX_TOKENS_FLOOR=${process.env.PI_MAX_TOKENS_FLOOR}` : "128000") };
	}

	async getModelConfigEditor(providerId: string, reqId: number): Promise<void> {
		try { this.host.emit({ type: "model_config_editor_result", providerId, reqId, status: "loaded", snapshot: this.editorSnapshot(providerId) }); }
		catch (error) { this.host.emit({ type: "model_config_editor_result", providerId, reqId, status: error instanceof ModelConfigDocumentError ? error.code : "invalid" }); }
	}

	async saveModelConfigPatch(providerId: string, reqId: number, version: string, changes: ModelConfigChange[]): Promise<void> {
		try {
			this.document.save(providerId, version, changes);
		} catch (error) {
			this.host.emit({ type: "model_config_editor_result", providerId, reqId, status: error instanceof ModelConfigDocumentError ? error.code : "invalid", field: error instanceof ModelConfigDocumentError ? error.field : undefined });
			return;
		}
		let status: "applied" | "pending" | "application_failed" = "applied";
		try {
			const sources = this.host.sources?.();
			if (sources) { await sources.sync(); status = sources.applicationState(this.host.modelRuntime()); }
			else { await this.host.modelRuntime().refresh({ allowNetwork: false }); if (this.host.modelRuntime().getError()) status = "application_failed"; }
			this.host.invalidatePiConfig();
			await this.listModelsConfig();
			await this.host.pushModels();
		} catch { status = "application_failed"; }
		try { this.host.emit({ type: "model_config_editor_result", providerId, reqId, status, snapshot: this.editorSnapshot(providerId) }); }
		catch { this.host.emit({ type: "model_config_editor_result", providerId, reqId, status: "application_failed" }); }
		if (status === "pending") this.pendingEditors.set(providerId, { reqId, version: this.document.read() });
		this.host.flushSnapshot();
	}

	modelConfigApplied(): void {
		const state = this.host.sources?.()?.applicationState(this.host.modelRuntime());
		if (!state || state === "pending") return;
		for (const [providerId, pending] of this.pendingEditors) {
			if (pending.version === this.document.read()) this.host.emit({ type: "model_config_editor_result", providerId, reqId: pending.reqId, status: state });
			this.pendingEditors.delete(providerId);
		}
	}

	/** Persist an api-key credential for a provider (auth.json) and apply it now. */
	async setProviderApiKey(provider: string, apiKey: string): Promise<void> {
		const key = apiKey.trim();
		if (!provider.trim()) {
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID" });
			return;
		}
		if (!key) {
			this.host.emit({ type: "notice", level: "error", text: "请填写 API 密钥" });
			return;
		}
		try {
			// Persist to auth.json ({ <provider>: { type: "api_key", key } }) under the SDK's lock.
			const authPath = join(this.host.agentDir, "auth.json");
			await updateAuthFile(authPath, (data) => ({ ...data, [provider.trim()]: { type: "api_key", key } }));
			// Apply immediately for this session (runtime credentials are cached), then
			// refresh models. allowNetwork downloads the provider's official model
			// catalog (openai/anthropic/… are dynamic providers with no built-in list).
			const mr = this.host.modelRuntime();
			await mr.setRuntimeApiKey(provider.trim(), key);
			await mr.refresh({ allowNetwork: true });
			this.host.invalidatePiConfig();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ 已保存 ${provider.trim()} 的 API 密钥并刷新模型列表`,
			});
			await this.host.pushModels();
			await this.listProviders();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `保存 API 密钥失败：${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/**
	 * Clear a built-in provider's stored API key (auth.json entry + runtime
	 * override) so it returns to the unconfigured state — its models disappear
	 * from the picker until a key is set again. Only meaningful for keys that
	 * were stored via set_provider_api_key (source "stored"); env-var sourced
	 * credentials can't be cleared from here.
	 */
	async clearProviderApiKey(provider: string): Promise<void> {
		const pid = provider.trim();
		if (!pid) {
			this.host.emit({ type: "notice", level: "error", text: "请填写服务商 ID" });
			return;
		}
		try {
			// Remove from auth.json ({ <provider>: { type: "api_key", key } }).
			const authPath = join(this.host.agentDir, "auth.json");
			const removed = await updateAuthFile(authPath, (data) => {
				if (!(pid in data)) return undefined;
				const { [pid]: _removed, ...rest } = data;
				return rest;
			});
			if (!removed) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `${pid} 没有已保存的密钥`,
				});
				return;
			}
			// Drop the runtime override too, then re-read credentials so the
			// provider goes back to unconfigured and its models leave the list.
			const mr = this.host.modelRuntime();
			await mr.removeRuntimeApiKey(pid);
			await mr.refresh();
			this.host.invalidatePiConfig();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🗑  已清除 ${pid} 的密钥，该服务商回到未配置状态`,
			});
			await this.host.pushModels();
			await this.listProviders();
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `清除密钥失败：${(err as Error).message}`,
			});
		}
		this.host.flushSnapshot();
	}

	/**
	 * Copy a BUILT-IN provider (baseUrl + current model catalog) into an
	 * editable custom-provider draft and return it via clone_provider_result.
	 * Nothing is persisted — the user renames the draft, pastes a DIFFERENT
	 * API key in the form, then saves via save_model_config. Credentials are
	 * never copied: the whole point is running a second key alongside the
	 * built-in one without touching it.
	 */
	async cloneProvider(providerId: string, reqId: number): Promise<void> {
		const pid = providerId.trim();
		const fail = (error: string) =>
			this.host.emit({ type: "clone_provider_result", reqId, ok: false, error });
		try {
			if (!pid) {
				fail("请填写服务商 ID");
				return;
			}
			const mr = this.host.modelRuntime();
			const p = mr.getProvider(pid);
			if (!p) {
				fail(`供应商 ${pid} 不存在`);
				return;
			}
			if (!p.baseUrl) {
				fail(`${pid} 没有 baseUrl（OAuth/环境变量型供应商），无法复制为自定义服务商`);
				return;
			}
			// Map runtime models → models.json rows; dynamic providers ship an
			// empty catalog until refreshed over the network.
			const readModels = (): { api: string; entry: UiModelConfigEntry }[] => {
				try {
					return mr.getModels(pid).map((m) => ({
						api: m.api,
						entry: {
							id: m.id,
							compat: readModelCompat(m.compat),
							...(m.name && m.name !== m.id ? { name: m.name } : {}),
							...(m.reasoning ? { reasoning: true } : {}),
							...(m.input?.includes("image")
								? { input: ["text", "image"] }
								: {}),
							...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
							...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
						},
					}));
				} catch {
					return [];
				}
			};
			let models = readModels();
			if (models.length === 0) {
				await mr.refresh({ allowNetwork: true });
				models = readModels();
			}
			if (models.length === 0) {
				fail(`${pid} 的模型列表为空，无法复制（请稍后重试）`);
				return;
			}
			// models.json 的 api 是 provider 级：取占比最高的 api，只复制该 api 的模型。
			const counts = new Map<string, number>();
			for (const m of models) counts.set(m.api, (counts.get(m.api) ?? 0) + 1);
			let api = models[0].api;
			for (const [k, v] of counts) if (v > (counts.get(api) ?? 0)) api = k;
			const kept = models.filter((m) => m.api === api).map((m) => m.entry);
			// Suggest a free id (<pid>-2, -3, …) — save_model_config would silently
			// overwrite an existing custom entry with the same id.
			const taken = new Set([
				...Object.keys(this.readModelsConfig().providers),
				...mr.getRegisteredProviderIds(),
			]);
			let newId = `${pid}-2`;
			for (let n = 2; taken.has(newId); n++) newId = `${pid}-${n}`;
			const config: UiProviderConfig = {
				providerId: newId,
				name: p.name,
				api,
				baseUrl: p.baseUrl,
				models: kept,
			};
			this.host.emit({
				type: "notice",
				level: "info",
				text: `📋 已复制 ${pid} → ${newId}（${kept.length} 个模型），请填入新的 API 密钥后保存`,
			});
			this.host.emit({ type: "clone_provider_result", reqId, ok: true, config });
		} catch (err) {
			fail(`复制服务商失败：${(err as Error).message}`);
		}
		this.host.flushSnapshot();
	}

	/** Enumerate pi's built-in providers with auth status (key-only config). */
	async listProviders(): Promise<void> {
		const mr = this.host.modelRuntime();
		let providers;
		try {
			providers = mr.getProviders().filter(p => isSelectableProvider(p.id) && !this.host.sources?.()?.owns(p.id)).map((p) => {
				try {
					const st = mr.getProviderAuthStatus(p.id);
					return {
						id: p.id,
						name: p.name,
						configured: st?.configured ?? false,
						oauth: !!p.auth.oauth,
						source: st?.source,
					};
				} catch {
					// One odd provider must not blank the whole list.
					return { id: p.id, name: p.name, configured: false };
				}
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `获取服务商列表失败：${(err as Error).message}`,
			});
			return;
		}
		if (providers.length === 0) {
			this.host.emit({
				type: "notice",
				level: "warning",
				text: "服务商列表为空——pi 运行时未注册任何提供商",
			});
		}
		this.host.emit({ type: "providers_status", providers });
	}

	// ---------------------------------------------------------------------------
	// Custom model config (agentDir/models.json)
	// ---------------------------------------------------------------------------


	/** Read + parse models.json (tolerating // and /* *\/ comments like the SDK). */
	/** Top-level keys other than providers (`$schema`, SDK 1.2+) are kept so writes round-trip them. */
	private readModelsConfig(): {
		providers: Record<string, Record<string, unknown>>;
		rest: Record<string, unknown>;
	} {
		const parsed = parseModelConfig(this.document.read());
		const { providers, ...rest } = parsed;
		return { providers: providers as Record<string, Record<string, unknown>>, rest };
	}

	/** Send the current models.json custom providers to the client. */
	async listModelsConfig(): Promise<void> {
		let providers: Record<string, Record<string, unknown>>;
		try { ({ providers } = this.readModelsConfig()); }
		catch { this.host.emit({ type: "models_config", providers: this.host.sources?.()?.configs() ?? [], sources: this.host.sources?.()?.status(this.host.modelRuntime()) }); this.host.emit({ type: "notice", level: "error", text: "模型配置损坏或不可读，未修改文件" }); return; }
		const list: UiProviderConfig[] = Object.entries(providers).filter(([id]) => isSelectableProvider(id)).map(
			([providerId, p]) => {
				const models = Array.isArray(p.models)
					? (p.models as Record<string, unknown>[]).filter(isChatModelConfig).map((m) => ({
							id: String(m.id ?? ""),
							name: m.name as string | undefined,
							compat: readModelCompat(m.compat),
							reasoning: m.reasoning as boolean | undefined,
							input: Array.isArray(m.input) ? (m.input as string[]) : undefined,
							contextWindow: m.contextWindow as number | undefined,
							maxTokens: m.maxTokens as number | undefined,
						}))
					: [];
				return {
					providerId,
					origin: this.host.sources?.()?.origin(providerId),
					name: p.name as string | undefined,
					compat: readModelCompat(p.compat),
					api: p.api as string | undefined,
					baseUrl: typeof p.baseUrl === "string" ? String(projectModelConfig(p.baseUrl, { type: "string" }, [], ["baseUrl"])) : undefined,
					nonChatModelCount: Array.isArray(p.models) ? p.models.filter(model => !isChatModelConfig(model)).length : 0,
					authHeader: p.authHeader as boolean | undefined,
					// headers are intentionally NOT sent to the browser — they may
					// contain Authorization / API-key values; kept server-side only.
					models,
				};
			},
		);
		this.host.emit({ type: "models_config", providers: [...list, ...(this.host.sources?.()?.configs() ?? [])], sources: this.host.sources?.()?.status(this.host.modelRuntime()) });
	}

	/** Numeric metadata value (NaN/string "unknown" → undefined). */
	private static numMeta(v: unknown): number | undefined {
		return typeof v === "number" && Number.isFinite(v) ? v : undefined;
	}

	private static boolMeta(v: unknown): boolean | undefined {
		return typeof v === "boolean" ? v : undefined;
	}

	private static strArrMeta(v: unknown): string[] | undefined {
		return Array.isArray(v)
			? v.filter((x): x is string => typeof x === "string")
			: undefined;
	}

	/** Best-effort extraction of model metadata from an OpenAI-compatible
	 *  /models `data[]` item. Most endpoints only return `{ id }` — the extra
	 *  fields (context_window / max_model_len / modalities / supports_vision /
	 *  reasoning / display_name) come from vLLM and other extended
	 *  implementations, and are filled into the form when present. */
	private static parseOpenAiModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const id = typeof r.id === "string" ? r.id : "";
		const name =
			(typeof r.name === "string" && r.name.trim() ? r.name : undefined) ??
			(typeof r.display_name === "string" && r.display_name.trim()
				? r.display_name
				: undefined);
		const modalities =
			strArrMeta(r.modalities) ??
			strArrMeta(r.input_modalities);
		const vision =
			modalities?.includes("image") === true ||
			boolMeta(r.supports_vision) === true ||
			boolMeta(r.vision) === true ||
			strArrMeta(r.input)?.includes("image") === true;
		const reasoning =
			boolMeta(r.reasoning) === true ||
			boolMeta(r.supports_reasoning) === true ||
			modalities?.includes("reasoning") === true;
		const contextWindow =
			numMeta(r.context_window) ??
			numMeta(r.context_length) ??
			numMeta(r.max_model_len) ??
			numMeta(r.max_context_length);
		const maxTokens =
			numMeta(r.max_tokens) ??
			numMeta(r.max_output_tokens) ??
			numMeta(r.max_completion_tokens);
		return {
			id,
			...(name ? { name } : {}),
			...(reasoning ? { reasoning: true } : {}),
			...(vision ? { input: ["text", "image"] } : {}),
			...(contextWindow ? { contextWindow } : {}),
			...(maxTokens ? { maxTokens } : {}),
		};
	}

	/** google-generative-ai /models shape:
	 *  { models: [{ name: "models/gemini-flash", displayName, inputTokenLimit,
	 *               outputTokenLimit, supportedGenerationMethods }] } */
	private static parseGoogleModel(m: unknown): UiModelConfigEntry {
		const r = (m ?? {}) as Record<string, unknown>;
		const rawName = typeof r.name === "string" ? r.name : "";
		const id = rawName.replace(/^models\//, "");
		const displayName = typeof r.displayName === "string" ? r.displayName : undefined;
		return {
			id,
			...(displayName && displayName !== id ? { name: displayName } : {}),
			...(numMeta(r.inputTokenLimit)
				? { contextWindow: numMeta(r.inputTokenLimit) }
				: {}),
			...(numMeta(r.outputTokenLimit)
				? { maxTokens: numMeta(r.outputTokenLimit) }
				: {}),
		};
	}

	/** Probe a custom provider's OpenAI-compatible /models endpoint (server-side
	 *  because the baseUrl is often a LAN/loopback host the browser can't reach
	 *  cross-origin) and return the advertised models. reqId is echoed back
	 *  in fetch_models_result so the UI can match concurrent requests. */
	async fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void> {
		const emitError = (error: string) =>
			this.host.emit({ type: "fetch_models_result", reqId, ok: false, error });
		try {
			const saved = providerId ? configRecord(configRecord(parseModelConfig(this.document.read()).providers)[providerId]) : {};
			const models = await ModelAdminService.probeModelsEndpoint(
				baseUrl || String(saved.baseUrl ?? ""),
				apiKey ?? (typeof saved.apiKey === "string" && !saved.apiKey.startsWith("!") && !saved.apiKey.includes("$") ? saved.apiKey : undefined),
				authHeader ?? (typeof saved.authHeader === "boolean" ? saved.authHeader : undefined),
				api ?? (typeof saved.api === "string" ? saved.api : undefined),
				Object.fromEntries(Object.entries(configRecord(saved.headers)).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !entry[1].startsWith("!") && !entry[1].includes("$"))),
			);
			this.host.emit({ type: "fetch_models_result", reqId, ok: true, models });
		} catch (err) {
			emitError("获取模型列表失败，请检查连接配置");
		}
	}

	/**
	 * Probe a custom provider's model-list endpoint (OpenAI-compatible /models
	 * with a /v1 retry; Google {models:[…]} shape supported). Throws Error with
	 * a user-facing message on any failure; returns deduped+sorted entries.
	 * Shared by the edit-form "auto fetch" and the saved-provider refresh.
	 */
static async probeModelsEndpoint(
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		extraHeaders?: Record<string, string>,
	): Promise<UiModelConfigEntry[]> {
		const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
		if (!base) throw new Error("请先填写 baseUrl");
		let url: URL;
		try {
			url = new URL(base);
		} catch {
			throw new Error(`baseUrl 无效：${base}`);
		}
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error("baseUrl 仅支持 http/https");
		}

		const headers: Record<string, string> = {
			...(extraHeaders ?? {}),
		};
		// Per-api auth conventions (mirror pi's built-in provider configs):
		//   openai-*:      Authorization: Bearer <key>
		//   anthropic:     x-api-key + anthropic-version
		//   google:        x-goog-api-key
		// authHeader=false → no auth header at all (custom gateways).
		if (apiKey?.trim() && authHeader !== false) {
			const key = apiKey.trim();
			if (api === "anthropic-messages") {
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			} else if (api === "google-generative-ai") {
				headers["x-goog-api-key"] = key;
			} else {
				headers["Authorization"] = `Bearer ${key}`;
			}
		}

		const tryFetch = async (u: string): Promise<Response | null> => {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 15000);
			try {
				return await fetch(u, { headers, signal: ac.signal });
			} catch (err) {
				if ((err as Error).name === "AbortError") {
					throw new Error("请求超时（15 秒）");
				}
				throw new Error(`请求失败：${(err as Error).message}`);
			} finally {
				clearTimeout(timer);
			}
		};

		let res = await tryFetch(`${base}/models`);
		// BaseUrls that omit the /v1 prefix (e.g. https://api.openai.com) 404 on
		// the bare path — retry under /v1.
		if (res && res.status === 404 && !/\/v\d+[a-z-]*$/.test(base)) {
			res = await tryFetch(`${base}/v1/models`);
		}
		if (!res) throw new Error("请求失败");
		if (!res.ok) {
			let detail = "";
			try {
				detail = (await res.text()).slice(0, 200);
			} catch {
				// response body already consumed / not text — ignore
			}
			throw new Error(`接口返回 HTTP ${res.status}${detail ? `：${detail}` : ""}`);
		}
		let models: UiModelConfigEntry[] = [];
		try {
			const json = (await res.json()) as Record<string, unknown>;
			const data = Array.isArray(json.data) ? json.data : null;
			if (data) {
				// OpenAI-compatible: { data: [{ id, context_window, modalities, … }] }
				models = data
					.map((m) => parseOpenAiModel(m))
					.filter((m) => m.id);
			} else if (Array.isArray(json.models)) {
				// Google: { models: [{ name: "models/…", displayName, … }] }
				models = (json.models as unknown[])
					.map((m) => parseGoogleModel(m))
					.filter((m) => m.id);
			}
		} catch {
			throw new Error("响应不是有效的 JSON");
		}
		// Dedupe by id (keep the first, most complete entry) and sort by id.
		const seen = new Set<string>();
		models = models
			.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (models.length === 0) throw new Error("接口未返回任何模型");
		return models;
	}

	/**
	 * Re-probe a SAVED custom provider's model list and merge it into its
	 * models.json entry — credentials never leave the server (unlike the
	 * edit-form fetch, which sends whatever the browser typed). Merge rules:
	 * existing ids keep all manually-entered fields and only gain metadata
	 * they were missing; brand-new ids are appended. Hot-reloads the runtime.
	 */
	async refreshProviderModels(providerId: string, reqId: number): Promise<void> {
		const done = (ok: boolean, extra: { added?: number; total?: number; error?: string } = {}) =>
			this.host.emit({ type: "refresh_provider_result", reqId, ok, ...extra });
		try {
			const pid = providerId.trim();
			const opened = this.document.open(pid);
			const providers = configRecord(opened.document.providers);
			// models.json 原始形状是 Record<string, unknown>——按已保存条目的结构断言
			const saved = providers[pid] as
				| {
						name?: string;
						api?: string;
						baseUrl?: string;
						apiKey?: string;
						authHeader?: boolean;
						headers?: Record<string, string>;
						models?: (UiModelConfigEntry & { type?: string })[];
				  }
				| undefined;
			if (!saved?.baseUrl?.trim()) {
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `服务商 ${pid} 不存在或未配置 baseUrl，无法刷新`,
				});
				return done(false, { error: "provider missing or no baseUrl" });
			}
			const fetched = await ModelAdminService.probeModelsEndpoint(
				saved.baseUrl,
				saved.apiKey,
				saved.authHeader === true ? true : undefined,
				saved.api,
				saved.headers as Record<string, string> | undefined,
			);

			// Merge: manual values win; fetched fills blanks and appends new ids.
			const prev = new Map((saved.models ?? []).filter(m => m.type === undefined || m.type === "chat").map((m) => [m.id, m]));
			let added = 0;
			for (const f of fetched) {
				const cur = prev.get(f.id);
				if (!cur) {
					prev.set(f.id, f);
					added += 1;
					continue;
				}
				prev.set(f.id, {
					...f,
					...cur, // 手填字段优先：cur 覆盖 f 的同名字段
				});
			}
			const merged = [...prev.values()].sort((a, b) =>
				a.id.localeCompare(b.id),
			);
			const previous = new Map((saved.models ?? []).filter(model => model.type === undefined || model.type === "chat").map(model => [model.id, model]));
			const changes: ModelConfigChange[] = fetched.map(model => ({ target: { kind: "model", id: model.id }, operations: Object.entries({ ...(previous.has(model.id) ? {} : { name: model.name ?? model.id }), ...model }).filter(([key, value]) => key !== "id" && value !== undefined && (previous.get(model.id) as Record<string, unknown> | undefined)?.[key] === undefined && Object.hasOwn(modelConfigSchemas.model.properties!, key)).map(([key, value]) => ({ op: "set", path: [key], value: value as ModelConfigValue })) }));
			this.document.save(pid, opened.version, changes);
			if (this.host.sources?.()) await this.host.sources()!.sync(); else await this.host.modelRuntime().refresh({ allowNetwork: false });
			await this.listModelsConfig();
			await this.host.pushModels();

			this.host.emit({
				type: "notice",
				level: "info",
				text:
					added > 0
						? `🔄 已刷新 ${pid}：新增 ${added} 个模型，共 ${merged.length} 个`
						: `🔄 已刷新 ${pid}：无新增模型（共 ${merged.length} 个）`,
			});
			return done(true, { added, total: merged.length });
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: `刷新模型列表失败：${(err as Error).message}`,
			});
			return done(false, { error: (err as Error).message });
		}
	}

	/** External-source edits retain their existing local-copy semantics. Native edits use field patches. */
	async saveModelConfig(
		providerId: string,
		config: UiProviderConfig,
	): Promise<void> {
		const pid = providerId.trim();
		if (this.host.sources?.()?.owns(pid)) {
			try { await this.host.sources()!.edit(pid, config); await this.listModelsConfig(); await this.host.pushModels(); }
			catch { this.host.emit({ type: "notice", level: "error", text: "保存独立模型失败，请检查配置" }); }
			return;
		}
		this.host.emit({ type: "notice", level: "error", text: "原生模型配置必须通过字段编辑器保存" });
	}

	/** Remove a provider from models.json and hot-reload. */
	async deleteModelConfig(providerId: string): Promise<void> {
		if (this.host.sources?.()?.owns(providerId)) {
			try { await this.host.sources()!.edit(providerId); await this.listModelsConfig(); await this.host.pushModels(); }
			catch { this.host.emit({ type: "notice", level: "error", text: "删除独立模型失败" }); }
			return;
		}
		try {
			if (!this.document.deleteProvider(providerId)) {
				this.host.emit({
					type: "notice",
					level: "info",
					text: `服务商 ${providerId} 不存在`,
				});
				return;
			}
			if (this.host.sources?.()) await this.host.sources()!.sync();
			else await this.host.modelRuntime().refresh({ allowNetwork: false });
			await this.listModelsConfig();
			await this.host.pushModels();
			this.host.emit({
				type: "notice",
				level: "info",
				text: `🗑  已删除服务商 ${providerId}`,
			});
		} catch (err) {
			this.host.emit({
				type: "notice",
				level: "error",
				text: "删除模型配置失败，请检查配置文件",
			});
		}
		this.host.flushSnapshot();
	}
}
