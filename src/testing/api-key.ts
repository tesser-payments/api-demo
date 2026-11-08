const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** A throwaway P-256 key in Turnkey's API key format: compressed hex public key, hex private scalar. */
export async function throwawayApiKey(): Promise<{ apiPublicKey: string; apiPrivateKey: string }> {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  const prefix = (y[y.length - 1]! & 1) === 0 ? "02" : "03";
  return { apiPublicKey: prefix + hex(x), apiPrivateKey: hex(Buffer.from(jwk.d!, "base64url")) };
}
