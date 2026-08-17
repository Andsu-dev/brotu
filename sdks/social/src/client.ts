import {
	type Account,
	fail,
	type OAuthFlow,
	PLATFORMS,
	type Platform,
	type PostRequest,
	type PostResult,
	type Result,
	type SocialProvider,
	type WebhookVerifier,
} from "./types";

export interface SocialClientOptions {
	/**
	 * Provider plugins. Each one owns a credential and the platforms it
	 * reaches — `meta()` covers Facebook, Instagram and Threads.
	 */
	providers?: SocialProvider[];
	/**
	 * Your Brotu key, for the platforms no plugin covers. Reserved: the hosted
	 * path is not open yet, and a platform without a plugin still errors.
	 */
	apiKey?: string;
}

/** What a platform namespace can do. Absent capabilities error, never lie. */
export interface PlatformNamespace {
	/** Publish. The whole point. */
	post(request: PostRequest): Promise<Result<PostResult>>;
	/** Accounts the configured credential can publish as. */
	accounts(): Promise<Result<Account[]>>;
	/** The OAuth dance, when the plugin can run it. */
	oauth: OAuthFlow | undefined;
	/** Verify and read this platform's webhooks. */
	webhooks: WebhookVerifier | undefined;
}

export type SocialClient = {
	[K in Platform]: PlatformNamespace;
} & {
	/** Same as `client.<platform>.post`, when the platform is a variable. */
	post(
		request: PostRequest & { provider: Platform },
	): Promise<Result<PostResult>>;
	/** Publish the same thing in several places. Never rejects; read each result. */
	postAll(
		request: PostRequest & { providers: Platform[] },
	): Promise<Result<PostResult>[]>;
	/** Platforms a registered plugin actually covers. */
	platforms(): Platform[];
};

export function brotu(options: SocialClientOptions = {}): SocialClient {
	// Last plugin registered for a platform wins, so a caller can override one
	// of Meta's three with a plugin of their own.
	const byPlatform = new Map<Platform, SocialProvider>();
	for (const provider of options.providers ?? []) {
		for (const platform of provider.platforms) {
			byPlatform.set(platform, provider);
		}
	}

	function missing(platform: Platform): Result<never> {
		return fail({
			code: "unconfigured_platform",
			message: `No provider is configured for ${platform}. Pass one — e.g. providers: [${pluginFor(platform)}({ … })].`,
			platform,
		});
	}

	async function post(
		platform: Platform,
		request: PostRequest,
	): Promise<Result<PostResult>> {
		const provider = byPlatform.get(platform);
		if (!provider) return missing(platform);
		if (!provider.publish) {
			return fail({
				code: "unsupported",
				message: `The ${provider.name} plugin cannot publish to ${platform} on its own yet.`,
				platform,
			});
		}
		if (!request.caption?.trim() && !request.mediaUrls?.length) {
			return fail({
				code: "invalid_request",
				message: "A post needs a caption, media, or both.",
				platform,
			});
		}
		return provider.publish(platform, request);
	}

	async function accounts(platform: Platform): Promise<Result<Account[]>> {
		const provider = byPlatform.get(platform);
		if (!provider) return missing(platform);
		if (!provider.accounts) {
			return fail({
				code: "unsupported",
				message: `The ${provider.name} plugin does not list ${platform} accounts.`,
				platform,
			});
		}
		return provider.accounts(platform);
	}

	const namespaces = Object.fromEntries(
		PLATFORMS.map((platform) => [
			platform,
			{
				post: (request: PostRequest) => post(platform, request),
				accounts: () => accounts(platform),
				get oauth() {
					return byPlatform.get(platform)?.oauth?.(platform);
				},
				get webhooks() {
					return byPlatform.get(platform)?.webhooks;
				},
			} satisfies PlatformNamespace,
		]),
	) as { [K in Platform]: PlatformNamespace };

	return {
		...namespaces,
		post: ({ provider, ...request }) => post(provider, request),
		postAll: ({ providers, ...request }) =>
			// Never rejects: one platform being down must not hide the ones that
			// worked. Every entry is a Result, in the order asked for.
			Promise.all(providers.map((platform) => post(platform, request))),
		platforms: () => [...byPlatform.keys()],
	};
}

/** Which import a caller is missing, named in the error rather than implied. */
function pluginFor(platform: Platform): string {
	if (
		platform === "facebook" ||
		platform === "instagram" ||
		platform === "threads"
	) {
		return "meta";
	}
	return platform;
}
