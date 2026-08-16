import { getModel } from "../catalog";
import type {
	CostEstimate,
	GenerationParams,
	GenerationType,
} from "../ports/content-generator.port";

/**
 * Count what the provider bills for, and price it only if the catalog carries a
 * verified rate. Every provider here charges your own account, so the SDK's job
 * is to say how much work you are asking for, not to invent a number.
 */
export function estimateFor(
	provider: string,
	type: GenerationType,
	params: GenerationParams,
	defaults?: { durationSeconds?: number },
): CostEstimate {
	const modelId = params.model ?? "";
	const model = getModel(modelId);

	const video = params as { duration?: number };
	const unit =
		model?.pricing?.unit ??
		(type === "video"
			? "second"
			: type === "audio"
				? "character"
				: type === "text"
					? "token"
					: "image");

	let units = 1;
	if (unit === "character") {
		// The only unit the caller fully controls before asking.
		units = (params as { prompt?: string }).prompt?.length ?? 0;
	} else if (unit === "token") {
		// The bill depends on how much the model writes back, which nobody knows
		// yet. Reporting a guessed token count would be worse than reporting none.
		units = 0;
	} else if (unit === "second") {
		units =
			video.duration ?? defaults?.durationSeconds ?? model?.minDuration ?? 5;
	}

	// Most video vendors charge differently per resolution.
	const resolution = (params as { resolution?: string }).resolution;
	const rate =
		(resolution ? model?.pricing?.byResolution?.[resolution] : undefined) ??
		model?.pricing?.usdPerUnit;
	return {
		unit,
		units,
		usd:
			rate === undefined || unit === "token"
				? null
				: Number((rate * units).toFixed(4)),
		note:
			unit === "token" && rate !== undefined
				? `Billed per token at $${(rate * 1_000_000).toFixed(2)} per million output tokens. The total depends on how much the model writes, so it is only known after generating.`
				: rate === undefined
					? `No verified rate for "${modelId}". It bills to your own ${provider} account; ${units} ${unit}${units === 1 ? "" : "s"} will be charged.`
					: undefined,
		provider,
		model: modelId,
	};
}
