/**
 * Alguns SDKs (ex.: UploadThing) põem o pedido HTTP inteiro — com a chave da
 * API nos cabeçalhos — no objeto de erro. Se esse erro chegar a um log (ou a
 * um `console.error(err)`), a chave vai com ele.
 *
 * Isto troca qualquer erro por um Error NOVO, só com a mensagem (sem `cause`,
 * sem `request`), e tapa o que parecer uma chave.
 */
const SECRET_PATTERNS = [/sk_(live|test)_[A-Za-z0-9]+/g, /eyJ[A-Za-z0-9_-]{20,}={0,2}/g];

export function redactSecrets(text: string) {
  return SECRET_PATTERNS.reduce((t, p) => t.replace(p, "***"), text);
}

export async function withoutSecrets<T>(label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${redactSecrets(message)}`);
  }
}
