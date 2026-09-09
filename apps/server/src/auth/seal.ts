/**
 * AES-256-GCM seal/open for small, sensitive values.
 *
 * Extracted from auth/session.ts so both browser-OAuth state and per-channel
 * MCP credentials share one envelope format and one key path. The envelope is
 * versioned (CIPHER_VERSION), random-nonce, and AAD-bound: a ciphertext sealed
 * under one purpose will not open under another.
 */

const CIPHER_VERSION = 1;
const NONCE_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function random(bytes: number): Uint8Array {
	let value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return value;
}

function buffer(value: Uint8Array): ArrayBuffer {
	return value.slice().buffer as ArrayBuffer;
}

/** Import a raw 32-byte key as a non-extractable AES-GCM key. */
export async function imported(value: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", buffer(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Seal a JSON-serializable value under a key and a purpose string (AAD). */
export async function encrypted(
	key: CryptoKey,
	aad: string,
	plaintext: unknown,
): Promise<Uint8Array> {
	let nonce = random(NONCE_BYTES);
	let content = encoder.encode(JSON.stringify(plaintext));
	let ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(encoder.encode(aad)) },
		key,
		buffer(content),
	);
	let envelope = new Uint8Array(1 + NONCE_BYTES + ciphertext.byteLength);
	envelope[0] = CIPHER_VERSION;
	envelope.set(nonce, 1);
	envelope.set(new Uint8Array(ciphertext), 1 + NONCE_BYTES);
	return envelope;
}

/** Open a sealed envelope under the same key and AAD it was sealed with. */
export async function decrypted(
	key: CryptoKey,
	aad: string,
	envelope: Uint8Array,
): Promise<unknown> {
	if (envelope.length <= 1 + NONCE_BYTES || envelope[0] !== CIPHER_VERSION) {
		throw new Error("bad envelope");
	}
	let nonce = envelope.slice(1, 1 + NONCE_BYTES);
	let ciphertext = envelope.slice(1 + NONCE_BYTES);
	let plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: buffer(nonce), additionalData: buffer(encoder.encode(aad)) },
		key,
		buffer(ciphertext),
	);
	return JSON.parse(decoder.decode(plaintext));
}
