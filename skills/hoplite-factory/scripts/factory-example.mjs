import { access, open, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

/** A runnable backend integration using only the public HTTP API and fetch.
 * factoryId must be persisted by your workflow engine and reused on retry.
 */
export async function runFactory({
	baseUrl,
	apiKey,
	factoryId,
	projectId,
	repositoryId,
	model,
	prompt,
	spendLimitMicros,
	attachmentPath,
	webhookUrl,
	onWebhookSecret,
	hasWebhookSecret = async () => false,
	merge = false,
	approveTools = false,
	fetch: fetchImpl = fetch,
	pollMs = 2000,
	timeoutMs = 30 * 60_000,
	onEvent = (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
}) {
	if (!apiKey || !factoryId || !prompt || (!projectId && !repositoryId))
		throw new Error(
			"Provide a service credential, a stable factory ID, a prompt, and a project or repository ID",
		);
	if (!Number.isSafeInteger(spendLimitMicros) || spendLimitMicros <= 0)
		throw new Error(
			"A positive spendLimitMicros is required before run admission",
		);
	if (factoryId.length > 48)
		throw new Error("Use a factory ID of at most 48 characters");
	if (webhookUrl && !onWebhookSecret)
		throw new Error(
			"Provide secure storage for the one-time webhook signing secret",
		);
	const origin = new URL(baseUrl);
	if (
		origin.protocol !== "https:" &&
		!["localhost", "127.0.0.1"].includes(origin.hostname)
	)
		throw new Error("Hoplite credentials require HTTPS");
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	async function request(path, { method = "GET", body, step } = {}) {
		const url = new URL(path, origin);
		if (url.origin !== origin.origin)
			throw new Error("Refusing to forward a credential to another origin");
		const headers = {
			"x-api-key": apiKey,
			accept: "application/json",
			...(body === undefined ? {} : { "content-type": "application/json" }),
			...(step ? { "Idempotency-Key": `${factoryId}:${step}` } : {}),
		};
		for (let attempt = 0; attempt < 5; attempt++) {
			let response;
			try {
				response = await fetchImpl(url, {
					method,
					headers,
					body: body === undefined ? undefined : JSON.stringify(body),
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				});
			} catch (error) {
				const transportCodes = new Set([
					"ECONNRESET",
					"ECONNREFUSED",
					"ETIMEDOUT",
					"EAI_AGAIN",
					"UND_ERR_CONNECT_TIMEOUT",
					"UND_ERR_HEADERS_TIMEOUT",
					"UND_ERR_SOCKET",
				]);
				const retryable =
					error?.name === "TimeoutError" ||
					(error instanceof TypeError && transportCodes.has(error.cause?.code));
				if (!retryable || attempt === 4) throw error;
				await sleep(1000 * (attempt + 1));
				continue;
			}
			const text = await response.text();
			let payload;
			try {
				payload = JSON.parse(text);
			} catch (error) {
				if (response.ok) throw error;
				payload = { error: "non_json_response", message: text.slice(0, 1024) };
			}
			if (payload === null || typeof payload !== "object")
				payload = { error: "invalid_response", message: String(payload) };
			if (response.ok) return payload;
			const operationId =
				response.headers.get("x-operation-id") ?? payload.operationId;
			// The first request with this key may still be running: wait and retry
			// the same key. An unknown outcome needs reconciliation, not a new key.
			if (payload.error === "operation_outcome_pending" && attempt < 4) {
				await sleep(
					Math.max(
						1000,
						Number(response.headers.get("retry-after")) * 1000 || 2000,
					),
				);
				continue;
			}
			if (
				payload.error === "operation_outcome_pending" ||
				payload.error === "operation_outcome_unknown"
			) {
				const receipt = operationId
					? await request(`/api/operations/${encodeURIComponent(operationId)}`)
					: null;
				throw new Error(
					JSON.stringify({
						error:
							"Reconcile the durable receipt before resuming; do not mint a new retry key",
						operationId,
						receipt,
					}),
				);
			}
			if ((response.status === 429 || response.status >= 500) && attempt < 4) {
				await sleep(
					Math.min(
						60_000,
						Math.max(
							1000,
							(Number(response.headers.get("retry-after")) || 1) * 1000,
						),
					),
				);
				continue;
			}
			throw Object.assign(
				new Error(
					JSON.stringify({
						status: response.status,
						requestId: response.headers.get("x-request-id"),
						operationId,
						...payload,
					}),
				),
				{ status: response.status, code: payload.error },
			);
		}
		throw new Error("Retry limit exhausted");
	}
	const capabilities = await request("/api/capabilities");
	if (
		!capabilities.availability.idempotency ||
		!capabilities.availability.events
	)
		throw new Error("Factory persistence is unavailable");
	const catalog = await request("/api/model-providers");
	const selectedModel = model ?? catalog.runConfig.defaultModelId;
	if (!catalog.models.some((candidate) => candidate.id === selectedModel))
		throw new Error(
			"The requested model is unavailable to this service identity",
		);
	const resolvedProjectId =
		projectId ??
		(
			await request("/api/projects", {
				method: "POST",
				step: "project",
				body: {
					name: `Factory ${factoryId}`,
					repositoryId,
					defaultModel: selectedModel,
				},
			})
		).project.id;
	const projectPath = `/api/projects/${encodeURIComponent(resolvedProjectId)}`;
	await request(`${projectPath}/repositories`);
	if (webhookUrl)
		await request("/api/webhooks", {
			method: "POST",
			step: "webhook",
			body: {
				url: webhookUrl,
				projectId: resolvedProjectId,
				types: ["run.completed", "run.failed", "approval.requested"],
			},
		}).then(async (result) => {
			if (result.secret) return onWebhookSecret(result.secret);
			// A replayed receipt omits the one-time secret. Resume when the first
			// response's secret was already stored; otherwise rotate it first.
			if (!(await hasWebhookSecret()))
				throw new Error(
					"The webhook signing secret is unavailable on replay. Recover the stored secret or rotate it before resuming this workflow.",
				);
		});
	const filter = `projectId=${encodeURIComponent(resolvedProjectId)}`;
	let cursor = (await request(`/api/events/head?${filter}`)).cursor;
	const threadBody = {
		projectId: resolvedProjectId,
		prompt,
		model: selectedModel,
		spendLimitMicros,
	};
	if (attachmentPath) {
		const maxBytes = capabilities.limits.attachmentMaxBytes;
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
			throw new Error(
				"The API did not advertise a valid attachment size limit",
			);
		const file = await open(attachmentPath, "r");
		const chunks = [];
		let total = 0;
		try {
			const info = await file.stat();
			if (!info.isFile() || info.size > maxBytes)
				throw new Error(
					`Attachment must be a regular file no larger than ${maxBytes} bytes`,
				);
			// Bound reads too: the file can grow after stat().
			for (;;) {
				const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
				const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
				if (bytesRead === 0) break;
				total += bytesRead;
				if (total > maxBytes)
					throw new Error(`Attachment exceeds ${maxBytes} bytes`);
				chunks.push(chunk.subarray(0, bytesRead));
			}
		} finally {
			await file.close();
		}
		const bytes = Buffer.concat(chunks, total);
		const initialClientOperationId = `${factoryId}:thread`;
		const { upload } = await request(
			`/api/threads/initial/attachments/presign?${filter}`,
			{
				method: "POST",
				step: "attachment",
				body: {
					initialClientOperationId,
					filename: basename(attachmentPath),
					contentType: "application/octet-stream",
					byteSize: bytes.byteLength,
				},
			},
		);
		const uploaded = await fetchImpl(upload.uploadUrl, {
			method: "PUT",
			body: bytes,
			headers: { "content-type": upload.contentType },
			redirect: "error",
			signal: AbortSignal.timeout(60_000),
		});
		if (!uploaded.ok)
			throw new Error(`Attachment upload failed: ${uploaded.status}`);
		threadBody.clientOperationId = initialClientOperationId;
		threadBody.initialAttachmentTickets = [upload.ticket];
	}
	const created = await request("/api/threads", {
		method: "POST",
		step: "thread",
		body: threadBody,
	});
	const threadId = created.thread.id;
	const threadPath = `/api/threads/${encodeURIComponent(threadId)}`;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (Date.now() >= deadline)
			throw new Error(
				`Factory timed out; inspect ${threadPath} and stop its active run if desired`,
			);
		try {
			const page = await request(
				`/api/events?${filter}&cursor=${encodeURIComponent(cursor)}`,
			);
			for (const event of page.events) onEvent(event);
			cursor = page.nextCursor;
		} catch (error) {
			if (error.status !== 410 || error.code !== "cursor_expired") throw error;
			// Capture the new head BEFORE the resource snapshot; replay covers changes
			// committed while that snapshot is being read.
			cursor = (await request(`/api/events/head?${filter}`)).cursor;
			await request(threadPath);
		}
		const { approvals } = await request(`${threadPath}/approvals`);
		for (const approval of approvals.filter((value) => value.actionable)) {
			if (!approveTools)
				throw new Error(
					`Approval ${approval.id} requires your workflow's policy decision`,
				);
			await request(
				`${threadPath}/approvals/${encodeURIComponent(approval.id)}`,
				{
					method: "POST",
					step: `approval:${approval.id}`,
					body: { approved: true },
				},
			);
		}
		let state;
		try {
			state = await request(`${threadPath}/run-state`);
		} catch (error) {
			if (error.status !== 404 || error.code !== "run_not_found") throw error;
			await sleep(pollMs);
			continue;
		}
		if (state.run?.status === "completed") break;
		if (["failed", "cancelled"].includes(state.run?.status))
			throw new Error(JSON.stringify({ threadId, run: state.run }));
		await sleep(pollMs);
	}
	const { diff } = await request(`${threadPath}/diff?mode=base`);
	const { checkpoints } = await request(`${threadPath}/checkpoints`);
	const { pullRequest } = await request(`${threadPath}/pr`, {
		method: "POST",
		step: "pr",
		body: { title: `Factory ${factoryId}`, draft: !merge },
	});
	let mergeResult = null;
	if (merge) {
		const { pullRequestStatus } = await request(`${threadPath}/pr/status`);
		const expectedHeadSha = pullRequestStatus.headSha;
		if (!expectedHeadSha)
			throw new Error("PR status did not expose a head SHA");
		mergeResult = await request(`${threadPath}/pr/merge`, {
			method: "POST",
			step: "merge",
			body: { expectedHeadSha, mergeMethod: "squash" },
		});
	}
	return {
		threadId,
		projectId: resolvedProjectId,
		pullRequest,
		diff,
		checkpoints,
		cursor,
		mergeResult,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const result = await runFactory({
		baseUrl: process.env.HOPLITE_API_URL ?? "https://api.hoplite.sh",
		apiKey: process.env.HOPLITE_API_KEY,
		factoryId: process.env.HOPLITE_FACTORY_ID,
		projectId: process.env.HOPLITE_PROJECT_ID,
		repositoryId: process.env.HOPLITE_REPOSITORY_ID,
		model: process.env.HOPLITE_MODEL,
		prompt: process.env.HOPLITE_PROMPT,
		spendLimitMicros: Number(process.env.HOPLITE_SPEND_LIMIT_MICROS),
		attachmentPath: process.env.HOPLITE_ATTACHMENT_PATH,
		webhookUrl: process.env.HOPLITE_WEBHOOK_URL,
		onWebhookSecret: process.env.HOPLITE_WEBHOOK_SECRET_FILE
			? (secret) =>
					writeFile(process.env.HOPLITE_WEBHOOK_SECRET_FILE, secret, {
						mode: 0o600,
						flag: "wx",
					})
			: undefined,
		hasWebhookSecret: () =>
			access(process.env.HOPLITE_WEBHOOK_SECRET_FILE ?? "").then(
				() => true,
				() => false,
			),
		merge: process.env.HOPLITE_MERGE === "true",
		approveTools: process.env.HOPLITE_APPROVE_TOOLS === "true",
	});
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
