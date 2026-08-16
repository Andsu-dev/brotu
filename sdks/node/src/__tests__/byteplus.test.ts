import { describe, expect, it } from "bun:test";
import { BytePlusAdapter } from "../adapters/byteplus.adapter";
import {
	BYTEPLUS_CATALOG,
	BYTEPLUS_IMAGE_CATALOG,
	BYTEPLUS_IMAGE_MODELS,
	BYTEPLUS_MODELS,
	fieldsFor,
} from "../providers/byteplus.models";

const adapter = new BytePlusAdapter({ apiKey: "ark-test" });

/** Reach the private body builder without going near the network. */
function body(model: string, params: Record<string, unknown>) {
	const inner = adapter as unknown as {
		buildBody: (
			id: string,
			binding: unknown,
			params: unknown,
		) => Record<string, unknown>;
	};
	return inner.buildBody(model, BYTEPLUS_MODELS[model], params);
}

/** Reach the private validator the same way. */
function validate(model: string, params: Record<string, unknown>) {
	const inner = adapter as unknown as {
		validate: (
			id: string,
			binding: unknown,
			kind: string,
			params: unknown,
		) => void;
	};
	return inner.validate(model, BYTEPLUS_MODELS[model], "video", params);
}

describe("field applicability", () => {
	it("allows seed and camera_fixed on 1.x but not on 2.x", () => {
		expect(fieldsFor("1.0").seed).toBe(true);
		expect(fieldsFor("1.5").seed).toBe(true);
		expect(fieldsFor("2.x").seed).toBe(false);
		expect(fieldsFor("2.x").cameraFixed).toBe(false);
	});

	it("allows generate_audio only where the model has audio", () => {
		expect(fieldsFor("1.0").generateAudio).toBe(false);
		expect(fieldsFor("1.5").generateAudio).toBe(true);
		expect(fieldsFor("2.x").generateAudio).toBe(true);
	});
});

describe("request body", () => {
	it("omits seed on 2.x, because Ark 400s on an inapplicable field", () => {
		const built = body("dreamina-seedance-2-0-260128", {
			prompt: "a cat",
			seed: 42,
		});
		expect(built.seed).toBeUndefined();
	});

	it("keeps seed on 1.0, where it is legal", () => {
		const built = body("seedance-1-0-pro-250528", {
			prompt: "a cat",
			seed: 42,
		});
		expect(built.seed).toBe(42);
	});

	it("always pins resolution, so 1.0-pro does not silently bill at 1080p", () => {
		const built = body("seedance-1-0-pro-250528", { prompt: "a cat" });
		expect(built.resolution).toBe("1080p");

		const lite = body("seedance-1-0-lite-t2v-250428", { prompt: "a cat" });
		expect(lite.resolution).toBe("720p");
	});

	it("sends the caller's resolution when they set one", () => {
		const built = body("dreamina-seedance-2-0-260128", {
			prompt: "a cat",
			resolution: "4k",
		});
		expect(built.resolution).toBe("4k");
	});

	it("puts the prompt in a text content item", () => {
		const built = body("seedance-1-0-pro-250528", { prompt: "a cat" });
		expect(built.content).toEqual([{ type: "text", text: "a cat" }]);
	});

	it("tags a single image as the first frame", () => {
		const built = body("seedance-1-0-pro-250528", {
			prompt: "a cat",
			imageUrl: "https://x/a.png",
		});
		expect(built.content).toEqual([
			{ type: "text", text: "a cat" },
			{
				type: "image_url",
				image_url: { url: "https://x/a.png" },
				role: "first_frame",
			},
		]);
	});

	it("refuses reference images on a family that rejects them", () => {
		expect(() =>
			body("seedance-1-0-pro-250528", {
				prompt: "a cat",
				imageUrls: ["https://x/a.png"],
			}),
		).toThrow(/takes no reference images/);
	});

	it("tags reference images on 2.x and caps them at the documented max", () => {
		const many = Array.from({ length: 12 }, (_, i) => `https://x/${i}.png`);
		const built = body("dreamina-seedance-2-0-260128", {
			prompt: "a cat",
			imageUrls: many,
		});
		const items = built.content as Array<{ role?: string }>;
		expect(items.filter((i) => i.role === "reference_image")).toHaveLength(9);
	});
});

describe("validation", () => {
	it("rejects a duration the model does not offer", () => {
		expect(() =>
			validate("dreamina-seedance-2-0-260128", { prompt: "a", duration: 40 }),
		).toThrow(/from 4 to 15s/);
	});

	it("accepts -1 on 2.x, where it means let the model choose", () => {
		expect(() =>
			validate("dreamina-seedance-2-0-260128", { prompt: "a", duration: -1 }),
		).not.toThrow();
	});

	it("rejects -1 on 1.0, where it is not a real duration", () => {
		expect(() =>
			validate("seedance-1-0-pro-250528", { prompt: "a", duration: -1 }),
		).toThrow(/from 2 to 12s/);
	});

	it("rejects a resolution the model does not have", () => {
		expect(() =>
			validate("dreamina-seedance-2-0-fast-260128", {
				prompt: "a",
				resolution: "4k",
			}),
		).toThrow(/supports 480p, 720p/);
	});

	it("tells an image-only model it needs an image", () => {
		expect(() =>
			validate("seedance-1-0-lite-i2v-250428", { prompt: "a" }),
		).toThrow(/only runs image-to-video/);
	});

	it("tells a text-only model it takes no image", () => {
		expect(() =>
			validate("seedance-1-0-lite-t2v-250428", {
				prompt: "a",
				imageUrl: "https://x/a.png",
			}),
		).toThrow(/only runs text-to-video/);
	});
});

describe("catalog", () => {
	it("exposes every model with the byteplus provider", () => {
		expect(BYTEPLUS_CATALOG.length).toBe(Object.keys(BYTEPLUS_MODELS).length);
		expect(BYTEPLUS_CATALOG.every((m) => m.provider === "byteplus")).toBe(true);
	});

	it("reports each model's real duration window", () => {
		const two = BYTEPLUS_CATALOG.find(
			(m) => m.id === "dreamina-seedance-2-5-260628",
		);
		expect(two?.minDuration).toBe(4);
		expect(two?.maxDuration).toBe(30);
	});
});

describe("image generation", () => {
	it("rejects a model that is not an image model", async () => {
		const result = await adapter.generateImage({
			prompt: "a cat",
			model: "seedance-1-0-pro-250528",
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not a BytePlus image model/);
	});

	it("rejects a size the model does not offer", async () => {
		const result = await adapter.generateImage({
			prompt: "a cat",
			model: "seedream-3-0-t2i-250415",
			resolution: "4K" as never,
		});
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/supports 1K, 2K/);
	});

	it("names every image model in the catalog", () => {
		expect(BYTEPLUS_IMAGE_CATALOG.length).toBe(
			Object.keys(BYTEPLUS_IMAGE_MODELS).length,
		);
		expect(BYTEPLUS_IMAGE_CATALOG.every((m) => m.category === "image")).toBe(
			true,
		);
	});
});
