import type { GenerationOutput } from "../ports/content-generator.port";

export interface S3StorageConfig {
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	region?: string;
	/** For R2, MinIO, or any S3-compatible host. Omit for AWS. */
	endpoint?: string;
	/** Public base (CDN or public bucket). Set it and nothing gets presigned. */
	publicUrl?: string;
	/** Key prefix, e.g. "generations". */
	prefix?: string;
	/** Presign lifetime when there is no `publicUrl`. Defaults to an hour. */
	signedUrlExpiresIn?: number;
	/**
	 * Copy finished outputs into the bucket. On by default, because provider URLs
	 * expire — often within hours — and a job you resume tomorrow would find
	 * nothing there.
	 */
	persistOutputs?: boolean;
}

export interface Storage {
	upload(buffer: Buffer, filename: string, mimeType: string): Promise<string>;
	/** Copy a provider URL into the bucket and return the durable URL. */
	persist(url: string, mimeType?: string): Promise<string>;
}

interface S3Client {
	send(command: unknown): Promise<unknown>;
}

/**
 * The AWS SDK is an optional peer dependency, loaded only when you configure
 * storage, so a project that never sets a bucket never pulls it in.
 */
async function loadS3(config: S3StorageConfig) {
	let s3: {
		S3Client: new (o: Record<string, unknown>) => S3Client;
		PutObjectCommand: new (o: Record<string, unknown>) => unknown;
		GetObjectCommand: new (o: Record<string, unknown>) => unknown;
	};
	try {
		s3 = (await import("@aws-sdk/client-s3")) as never;
	} catch {
		throw new Error(
			"Configuring `storage` needs @aws-sdk/client-s3. Install it: bun add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner",
		);
	}

	const client = new s3.S3Client({
		region: config.region ?? "us-east-1",
		endpoint: config.endpoint,
		// Custom hosts (R2, MinIO) serve one bucket per path, not per subdomain.
		forcePathStyle: Boolean(config.endpoint),
		credentials: {
			accessKeyId: config.accessKeyId,
			secretAccessKey: config.secretAccessKey,
		},
	});

	return { client, ...s3 };
}

function keyFor(config: S3StorageConfig, filename: string): string {
	const prefix = config.prefix?.replace(/^\/|\/$/g, "");
	const stamp = Date.now();
	const safe = filename.replace(/[^\w.-]/g, "_");
	return prefix ? `${prefix}/${stamp}-${safe}` : `${stamp}-${safe}`;
}

function extensionFor(url: string, mimeType?: string): string {
	const fromUrl = new URL(url).pathname.split(".").pop();
	if (fromUrl && fromUrl.length <= 5 && /^[a-z0-9]+$/i.test(fromUrl)) {
		return fromUrl;
	}
	if (mimeType?.startsWith("video/")) return "mp4";
	if (mimeType === "image/jpeg") return "jpg";
	return "png";
}

export function createS3Storage(config: S3StorageConfig): Storage {
	let loaded: Awaited<ReturnType<typeof loadS3>> | undefined;

	async function s3() {
		loaded ??= await loadS3(config);
		return loaded;
	}

	async function urlFor(key: string): Promise<string> {
		if (config.publicUrl) {
			return `${config.publicUrl.replace(/\/$/, "")}/${key}`;
		}

		const { client, GetObjectCommand } = await s3();
		let presigner: {
			getSignedUrl(c: unknown, cmd: unknown, o: unknown): Promise<string>;
		};
		try {
			presigner = (await import("@aws-sdk/s3-request-presigner")) as never;
		} catch {
			throw new Error(
				"Signing a URL needs @aws-sdk/s3-request-presigner, or set storage.publicUrl to skip signing.",
			);
		}

		return presigner.getSignedUrl(
			client,
			new GetObjectCommand({ Bucket: config.bucket, Key: key }),
			{ expiresIn: config.signedUrlExpiresIn ?? 3600 },
		);
	}

	return {
		async upload(buffer, filename, mimeType) {
			const { client, PutObjectCommand } = await s3();
			const key = keyFor(config, filename);
			await client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: key,
					Body: buffer,
					ContentType: mimeType,
				}),
			);
			return urlFor(key);
		},

		async persist(url, mimeType) {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Could not fetch ${url} to persist it: ${response.status} ${response.statusText}`,
				);
			}

			const buffer = Buffer.from(await response.arrayBuffer());
			const contentType =
				mimeType ??
				response.headers.get("content-type") ??
				"application/octet-stream";

			const { client, PutObjectCommand } = await s3();
			const key = keyFor(config, `output.${extensionFor(url, contentType)}`);
			await client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: key,
					Body: buffer,
					ContentType: contentType,
				}),
			);
			return urlFor(key);
		},
	};
}

/**
 * Rewrite outputs to point at the bucket. A failure to copy one leaves that
 * output on its provider URL rather than losing the whole generation.
 */
export async function persistOutputs(
	storage: Storage,
	outputs: GenerationOutput[],
): Promise<GenerationOutput[]> {
	return Promise.all(
		outputs.map(async (output) => {
			try {
				const url = await storage.persist(output.url, output.mimeType);
				return {
					...output,
					url,
					sourceUrl: output.url,
					// The copy is ours now, so the provider's clock no longer applies.
					expiresAt: undefined,
				};
			} catch (error) {
				console.warn(
					`[storage] Kept the provider URL for ${output.url}:`,
					error,
				);
				return output;
			}
		}),
	);
}
