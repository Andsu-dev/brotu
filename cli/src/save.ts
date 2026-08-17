import { writeFile } from "node:fs/promises";

/** Write a generation URL (https or data:) to disk. */
export async function saveOutput(url: string, dest: string): Promise<void> {
	if (url.startsWith("data:")) {
		const comma = url.indexOf(",");
		const payload = comma >= 0 ? url.slice(comma + 1) : "";
		await writeFile(dest, Buffer.from(payload, "base64"));
		return;
	}

	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`download failed (${response.status}) for ${url}`);
	}
	await writeFile(dest, Buffer.from(await response.arrayBuffer()));
}
