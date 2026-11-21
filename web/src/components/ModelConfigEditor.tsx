import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ModelConfigChange, ModelConfigEditorResult, ModelConfigEditorSnapshot, ModelConfigSchema, ModelConfigTarget, ModelConfigValue, UiModelConfigEntry, UiProviderConfig } from "../types";
import { compactConfigChanges, configOperations, initialConfigValue, modelFieldGroups, schemaForValue, valueKind } from "../model-config-fields";
import { useT, type Translate } from "../i18n";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { useDialogFocus } from "../use-dialog-focus";

const object = (value: ModelConfigValue | undefined): Record<string, ModelConfigValue> => value && !Array.isArray(value) && typeof value === "object" ? value : {};
const fieldLabels: Record<string, string> = {
	name: "mcName", api: "mcApi", baseUrl: "mcBaseUrl", apiKey: "mcApiKey", authHeader: "mcAuthHeader", oauth: "mcOAuth", reasoning: "mcReasoning", input: "mcInput", contextWindow: "mcContext", maxTokens: "mcMaxTokens",
	thinkingLevelMap: "mcThinking", samplingParams: "mcSampling", samplingParamsByThinkingLevel: "mcSamplingLevels", cost: "mcPricing", inputLimits: "mcInputLimits", promptCache: "mcCache", compat: "mcCompatibility", headers: "mcHeaders",
};
const label = (key: string, t: Translate) => fieldLabels[key] ? t(fieldLabels[key] as Parameters<Translate>[0]) : key;

function ConfigField({ name, schema, value, onChange, secret = false, locked = false, path = [], secrets = [] }: {
	name: string; schema: ModelConfigSchema; value: ModelConfigValue | undefined; onChange: (value: ModelConfigValue | undefined) => void;
	secret?: boolean; locked?: boolean; path?: (string | number)[]; secrets?: (string | number)[][];
}) {
	const t = useT();
	const [newKey, setNewKey] = useState("");
	const branch = schemaForValue(schema, value);
	const type = branch.type ?? (branch.properties || branch.patternProperties ? "object" : value === undefined || value === null ? "string" : valueKind(value));
	const nullable = schema.anyOf?.some(option => option.type === "null") || schema.type === "null";
	const alternatives = schema.anyOf?.filter(option => option.type !== "null");
	const enumValues = schema.enum ?? (schema.anyOf?.every(option => Object.hasOwn(option, "const")) ? schema.anyOf.map(option => option.const!) : Object.hasOwn(branch, "const") ? [branch.const!] : undefined);
	const isSecret = secret || name === "apiKey" || path.includes("headers") && path.at(-1) !== "headers" || secrets.some(secretPath => JSON.stringify(secretPath) === JSON.stringify(path));
	const heading = <span className="mc-field-label">{label(name, t)}{fieldLabels[name] && <code>{name}</code>}</span>;
	if (locked) return <div className="mc-field">{heading}<input value={String(value ?? "")} readOnly /></div>;
	if (!schema.type && !schema.anyOf && !isSecret) return <fieldset className="mc-object"><legend>{heading}</legend><select aria-label={`${name} ${t("mcType")}`} value={value === undefined ? "string" : valueKind(value)} onChange={event => onChange(initialConfigValue({ type: event.target.value }))}>{["string", "number", "boolean", "null", "object", "array"].map(kind => <option key={kind}>{kind}</option>)}</select><ConfigField name={name} schema={{ type: value === undefined ? "string" : valueKind(value) }} value={value} onChange={onChange} path={path} secrets={secrets} /></fieldset>;
	if (alternatives && new Set(alternatives.map(option => option.type)).size > 1 && !enumValues && !isSecret) return <fieldset className="mc-object"><legend>{heading}</legend><select aria-label={`${name} ${t("mcType")}`} value={value === null ? "null" : type} onChange={event => onChange(initialConfigValue(schema.anyOf!.find(option => option.type === event.target.value)!))}>{schema.anyOf!.map((option, index) => <option key={index} value={option.type}>{option.type}</option>)}</select><ConfigField name={name} schema={value === null ? { type: "null" } : branch} value={value} onChange={onChange} path={path} secrets={secrets} /></fieldset>;
	const reset = value !== undefined && <button type="button" className="btn sm" onClick={() => onChange(undefined)} aria-label={`${t("mcInherit")} ${name}`}>{t("mcInherit")}</button>;
	if (isSecret) return <div className="mc-field">{heading}<div className="mc-inline"><input type="password" autoComplete="new-password" aria-label={name} value={typeof value === "string" ? value : ""} placeholder={value !== undefined ? t("mcConfigured") : ""} onChange={event => onChange(event.target.value || undefined)} />{reset}</div></div>;
	if (enumValues || type === "boolean") {
		const options = enumValues ?? [true, false];
		return <label className="mc-field">{heading}<select value={value === undefined ? "inherit" : JSON.stringify(value)} onChange={event => onChange(event.target.value === "inherit" ? undefined : JSON.parse(event.target.value))}><option value="inherit">{t("mcInherit")}</option>{options.map(option => <option key={JSON.stringify(option)} value={JSON.stringify(option)}>{typeof option === "boolean" ? t(option ? "compatEnabled" : "compatDisabled") : String(option)}</option>)}{nullable && <option value="null">{t(path[0] === "thinkingLevelMap" ? "mcUnsupported" : "mcNull")}</option>}</select></label>;
	}
	if (type === "object" || type === "array") {
		const record = object(value);
		const dynamic = Object.values(branch.patternProperties ?? {})[0] ?? (typeof branch.additionalProperties === "object" ? branch.additionalProperties : !branch.properties || branch.additionalProperties === true && !branch.properties ? {} : undefined);
		return <fieldset className="mc-object"><legend>{heading}</legend><div className="mc-inline">{value === undefined ? <button className="btn sm" type="button" onClick={() => onChange(initialConfigValue(branch))}>{t("mcConfigure")}</button> : reset}
		{alternatives && alternatives.length > 1 && <select aria-label={`${name} ${t("mcType")}`} value={type} onChange={event => onChange(initialConfigValue(alternatives.find(option => option.type === event.target.value)!))}>{alternatives.map((option, index) => <option key={index} value={option.type}>{option.type}</option>)}</select>}</div>
		{type === "array" ? <>
			{(Array.isArray(value) ? value : []).map((item, index, rows) => <div className="mc-array-row" key={index}><ConfigField name={String(index + 1)} schema={branch.items ?? {}} value={item} path={[...path, index]} secrets={secrets} onChange={updated => onChange(updated === undefined ? rows.filter((_, i) => i !== index) : rows.map((row, i) => i === index ? updated : row))} /><button type="button" className="btn sm danger" aria-label={`${t("delete")} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}>{t("delete")}</button></div>)}
			<button className="btn sm" type="button" onClick={() => onChange([...(Array.isArray(value) ? value : []), initialConfigValue(branch.items ?? {})])}>{t("mcAddRow")}</button>
		</> : <>
			{[...new Set([...Object.keys(branch.properties ?? {}), ...Object.keys(record).filter(key => !branch.properties || Object.hasOwn(branch.properties, key))])].map(key => <ConfigField key={key} name={key} schema={branch.properties?.[key] ?? dynamic ?? {}} value={record[key]} path={[...path, key]} secrets={secrets} onChange={updated => { const next = { ...object(initialConfigValue(branch)), ...record }; if (updated === undefined) delete next[key]; else next[key] = updated; onChange(Object.keys(next).length ? next : undefined); }} />)}
			{dynamic && <div className="mc-inline"><input aria-label={t("mcNewField")} value={newKey} placeholder={t("mcNewField")} onChange={event => setNewKey(event.target.value)} /><button className="btn sm" type="button" disabled={!newKey.trim() || Object.hasOwn(record, newKey.trim()) || ["__proto__", "constructor", "prototype"].includes(newKey.trim())} onClick={() => { onChange({ ...record, [newKey.trim()]: initialConfigValue(dynamic) }); setNewKey(""); }}>{t("mcAddRow")}</button></div>}
		</>}
		</fieldset>;
	}
	return <div className="mc-field">{heading}<div className="mc-inline">
		{!schema.type && !schema.anyOf && <select aria-label={`${name} ${t("mcType")}`} value={valueKind(value) === "undefined" ? "string" : valueKind(value)} onChange={event => onChange(initialConfigValue({ type: event.target.value }))}>{["string", "number", "boolean", "null", "object", "array"].map(kind => <option key={kind}>{kind}</option>)}</select>}
		{value === null ? <button className="btn sm" type="button" onClick={() => onChange(initialConfigValue({ ...schema, type: schema.type === "null" ? "string" : schema.type }))}>{t(path[0] === "thinkingLevelMap" ? "mcUnsupported" : "mcNull")}</button> : <input aria-label={name} type={type === "number" || type === "integer" ? "number" : "text"} min={branch.minimum ?? branch.exclusiveMinimum} max={branch.maximum} step={type === "integer" ? 1 : "any"} value={typeof value === "string" || typeof value === "number" ? value : ""} placeholder={branch.default !== undefined ? `${t("mcInherit")} (${String(branch.default)})` : t("mcInherit")} onChange={event => onChange(event.target.value === "" ? type === "number" || type === "integer" || (branch.minLength ?? 0) > 0 ? undefined : "" : type === "number" || type === "integer" ? Number(event.target.value) : event.target.value)} />}
		{nullable && value !== null && <button className="btn sm" type="button" onClick={() => onChange(null)}>{t(path[0] === "thinkingLevelMap" ? "mcUnsupported" : "mcNull")}</button>}{reset}
	</div></div>;
}

function ConfigGroup({ title, initiallyOpen, children }: { title: string; initiallyOpen: boolean; children: React.ReactNode }) {
	const [open, setOpen] = useState(initiallyOpen);
	return <details className="mc-group" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{title}</summary><div className="mc-fields">{children}</div></details>;
}

type DraftRow = ModelConfigEditorSnapshot["models"][number] & { removed?: boolean; added?: boolean };
export function ModelConfigEditor({ providerId: initialProviderId, seed, fetchResult, send, onBack, closeSignal = 0 }: { providerId: string; seed?: UiProviderConfig; fetchResult?: { reqId: number; ok: boolean; models?: UiModelConfigEntry[]; error?: string } | null; send: (message: ClientMessage) => boolean; onBack: () => void; closeSignal?: number }) {
	const t = useT();
	const [providerId, setProviderId] = useState(seed?.providerId ?? initialProviderId);
	const [snapshot, setSnapshot] = useState<ModelConfigEditorSnapshot>();
	const [provider, setProvider] = useState<Record<string, ModelConfigValue>>({});
	const [rows, setRows] = useState<DraftRow[]>([]);
	const [selected, setSelected] = useState(-1);
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<ModelConfigEditorResult["status"]>();
	const [errorField, setErrorField] = useState<string>();
	const [confirm, setConfirm] = useState(false);
	const [newId, setNewId] = useState("");
	const fetchReq = useRef(0);
	const [fetching, setFetching] = useState(false);
	const req = useRef(0), leaving = useRef(false), seeded = useRef(false);
	const confirmationRef = useDialogFocus<HTMLElement>(confirm);
	const editorRef = useRef<HTMLDivElement>(null);
	const changes: ModelConfigChange[] = snapshot ? compactConfigChanges([
		{ target: { kind: "provider" }, operations: configOperations(snapshot.provider, provider) },
		...rows.map(row => ({ target: row.target, remove: row.removed && !row.added, operations: row.removed ? [] : configOperations(snapshot.models.find(base => base.target.kind === row.target.kind && base.target.id === row.target.id)?.value ?? {}, row.value).filter(operation => operation.path[0] !== "id") })),
	]) : [];
	const dirty = changes.length > 0;
	useEffect(() => {
		if (!fetchResult || fetchResult.reqId !== fetchReq.current) return;
		setFetching(false);
		if (!fetchResult.ok) { setStatus("invalid"); return; }
		setRows(previous => {
			const next = [...previous];
			for (const model of fetchResult.models ?? []) {
				const index = next.findIndex(row => row.target.id === model.id && !row.removed);
				const values = JSON.parse(JSON.stringify({ name: model.name ?? model.id, ...model })) as Record<string, ModelConfigValue>;
				if (index < 0) next.push({ target: { kind: "model", id: model.id }, value: values, secretPaths: [], added: true });
				else if (next[index].target.kind === "model") next[index] = { ...next[index], value: { ...values, ...next[index].value } };
			}
			return next;
		});
	}, [fetchResult]);
	const accept = (next: ModelConfigEditorSnapshot) => { setSnapshot(next); setProvider(next.provider); setRows(next.models); setProviderId(next.providerId || initialProviderId); };
	useEffect(() => {
		const receive = (event: Event) => {
			const result = (event as CustomEvent<ModelConfigEditorResult>).detail;
			if (result.reqId !== req.current) return;
			if (!result.snapshot && (result.status === "applied" || result.status === "application_failed")) { setBusy(false); setStatus(result.status); return; }
			setBusy(false); setStatus(result.status); setErrorField(result.field);
			if (result.snapshot) {
				accept(result.snapshot);
				if (seed && !seeded.current && result.status === "loaded") {
					seeded.current = true;
					const { providerId: _id, models, origin: _origin, nonChatModelCount: _count, ...values } = seed;
					setProviderId(seed.providerId);
					setProvider(JSON.parse(JSON.stringify(values)));
					setRows(models.filter(model => model.id).map(model => ({ target: { kind: "model", id: model.id }, value: JSON.parse(JSON.stringify(model)), secretPaths: [], added: true })));
				}
			}
			if (["applied", "pending", "application_failed"].includes(result.status) && leaving.current) onBack();
			leaving.current = false;
		};
		window.addEventListener("pi-model-config-event", receive);
		req.current = Date.now(); setBusy(true);
		if (!send({ type: "get_model_config_editor", providerId: seed ? "" : initialProviderId, reqId: req.current })) { setBusy(false); setStatus("unreadable"); }
		return () => window.removeEventListener("pi-model-config-event", receive);
	}, [initialProviderId, send]);
	const requestBack = () => { if (busy) return; if (dirty) setConfirm(true); else onBack(); };
	useEffect(() => {
		const disconnected = () => { setFetching(false); if (busy) { setBusy(false); setStatus("unreadable"); } };
		window.addEventListener("pi-model-config-disconnected", disconnected);
		return () => window.removeEventListener("pi-model-config-disconnected", disconnected);
	}, [busy]);
	const previousSignal = useRef(closeSignal);
	useEffect(() => { if (closeSignal !== previousSignal.current) { previousSignal.current = closeSignal; requestBack(); } }, [closeSignal]);
	const save = () => {
		if (!snapshot || busy || !dirty || !providerId.trim()) return;
		req.current = Date.now(); setBusy(true); setStatus(undefined); setConfirm(false);
		if (!send({ type: "save_model_config_patch", providerId: providerId.trim() || snapshot.providerId, reqId: req.current, version: snapshot.version, changes })) { setBusy(false); setStatus("unreadable"); }
	};
	useEffect(() => {
		if (!errorField) return;
		const key = errorField.split(/[/.]/).filter(Boolean).at(-1);
		const control = Array.from(editorRef.current?.querySelectorAll<HTMLElement>("[aria-label]") ?? []).find(element => element.getAttribute("aria-label") === key);
		let parent = control?.parentElement;
		while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
		control?.focus();
	}, [errorField]);
	const current = selected < 0 ? undefined : rows[selected];
	const value = current?.value ?? provider;
	const schema = snapshot?.schemas[current?.target.kind ?? "provider"];
	const secrets = current?.secretPaths ?? snapshot?.secretPaths ?? [];
	const effectiveApi = String(current?.value.api ?? (current ? provider.api ?? current.effective?.api : provider.api) ?? "");
	const compatSchema = snapshot?.compatSchemas[effectiveApi];
	const update = (field: string, updated: ModelConfigValue | undefined) => {
		const next = { ...value }; if (updated === undefined) delete next[field]; else next[field] = updated;
		if (current) setRows(previous => previous.map((row, index) => index === selected ? { ...row, value: next } : row)); else setProvider(next);
	};
	return <div className="mc-editor" ref={editorRef}>
		<div className="mc-toolbar"><button className="btn" type="button" disabled={busy} onClick={requestBack}>{t("mcBack")}</button><strong>{providerId || t("addProvider")}</strong><button type="button" className="btn" disabled={fetching || busy || !snapshot} onClick={() => { fetchReq.current = Date.now(); setFetching(true); if (!send({ type: "fetch_models", reqId: fetchReq.current, providerId: seed ? undefined : initialProviderId || undefined, baseUrl: secrets.some(path => path.length === 1 && path[0] === "baseUrl") && provider.baseUrl === snapshot?.provider.baseUrl ? "" : String(provider.baseUrl ?? ""), apiKey: typeof provider.apiKey === "string" ? provider.apiKey : undefined, api: typeof provider.api === "string" ? provider.api : undefined, authHeader: typeof provider.authHeader === "boolean" ? provider.authHeader : undefined })) setFetching(false); }}>{t("fetchModels")}</button><button type="button" className="btn primary" disabled={busy || !dirty || !providerId.trim()} onClick={save}>{t(busy ? "mcSaving" : "mcSave")}</button></div>
		{status && status !== "loaded" && <div role={status === "applied" ? "status" : "alert"} className={`mc-status ${["invalid", "conflict", "unreadable", "application_failed"].includes(status) ? "mc-error" : ""}`}>{t(`mcStatus_${status}` as Parameters<Translate>[0])}{errorField && <code>{errorField}</code>}{status === "conflict" && <button className="btn sm" type="button" onClick={() => { req.current = Date.now(); setBusy(true); if (!send({ type: "get_model_config_editor", providerId, reqId: req.current })) { setBusy(false); setStatus("unreadable"); } }}>{t("mcReload")}</button>}</div>}
		{snapshot && <><div className="mc-source"><code>{snapshot.path}</code>{snapshot.outputOverride && <span>PI_MAX_TOKENS · {snapshot.outputOverride}</span>}</div><fieldset disabled={busy} className="mc-workspace">
			<nav className="mc-nav" aria-label={t("modelsTitle")}><button type="button" className={selected === -1 ? "selected" : ""} onClick={() => setSelected(-1)}>{t("mcProviderSettings")}</button><input type="search" aria-label={t("mcSearchModels")} placeholder={t("mcSearchModels")} value={search} onChange={event => setSearch(event.target.value)} />
				{rows.map((row, index) => !row.removed && `${row.target.id} ${row.value.name ?? row.effective?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()) && <button key={`${row.target.kind}:${row.target.id}`} type="button" className={selected === index ? "selected" : ""} onClick={() => setSelected(index)}><span>{String(row.value.name ?? row.effective?.name ?? row.target.id)}</span><code>{row.target.id}</code><small>{t(row.target.kind === "override" ? "mcOverride" : "mcDefinition")}</small></button>)}
				<div className="mc-new-model"><input aria-label={t("mcNewModelId")} placeholder={t("mcNewModelId")} value={newId} onChange={event => setNewId(event.target.value)} /><button type="button" className="btn sm" disabled={!newId.trim() || rows.some(row => !row.removed && row.target.id === newId.trim())} onClick={() => { setRows(previous => [...previous, { target: { kind: "model", id: newId.trim() }, value: { id: newId.trim(), name: newId.trim() }, secretPaths: [], added: true }]); setSelected(rows.length); setNewId(""); }}>{t("mcAddModel")}</button></div>
			</nav>
			<section className="mc-detail"><div className="mc-detail-heading"><h3>{current?.target.id ?? t("mcProviderSettings")}</h3>{current && <button className="btn sm danger" type="button" onClick={() => { setRows(previous => previous.map((row, index) => index === selected ? row.target.kind === "override" ? { ...row, value: {} } : { ...row, removed: true } : row)); if (current.target.kind !== "override") setSelected(-1); }}>{t(current.target.kind === "override" ? "mcResetOverride" : "delete")}</button>}</div>
				{(!initialProviderId || seed) && !snapshot.providerId && !current && <label className="mc-field"><span>{t("providerId")}</span><input value={providerId} onChange={event => setProviderId(event.target.value)} /></label>}
				{current?.effective && <div className="mc-effective"><span>{t("mcEffective")}</span><span>{t("mcContext")}: {String(current.effective.contextWindow)}</span><span>{t("mcMaxTokens")}: {String(current.effective.maxTokens)}</span></div>}
				{modelFieldGroups.map(group => {
					const fields = group.fields.filter(field => schema?.properties?.[field]);
					if (!fields.length) return null;
					return <ConfigGroup key={`${selected}:${group.key}`} title={t(`mcGroup_${group.key}` as Parameters<Translate>[0])} initiallyOpen={group.key === "basic" || group.key === "capabilities"}>{fields.map(field => <ConfigField key={`${selected}:${field}`} name={field} schema={field === "compat" && effectiveApi ? compatSchema ?? { type: "object", properties: {} } : schema!.properties![field]} value={value[field]} path={[field]} secrets={secrets} locked={field === "id"} onChange={updated => update(field, updated)} />)}</ConfigGroup>;
				})}
			</section>
		</fieldset></>}
		{confirm && <UnsavedChangesDialog dialogRef={confirmationRef} busy={busy} saving={busy} onCancel={() => setConfirm(false)} onDiscard={onBack} onSave={() => { leaving.current = true; save(); }} />}
	</div>;
}
